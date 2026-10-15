const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const path = require('path');
const fs = require('fs');
const async = require('async');
const { ZipArchive } = require('archiver');
const { MAX_GLOBAL_QUEUE, MAX_USER_ACTIVE_JOBS } = require('../utils/systemLimits');

// Set static paths explicitly
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

console.log('[FFMPEG] ffmpeg path:', ffmpegStatic);
console.log('[FFMPEG] ffprobe path:', ffprobeStatic.path);

// Garantir permissão de execução nos binários para contêineres Linux (Railway)
try {
    if (fs.existsSync(ffmpegStatic)) {
        fs.chmodSync(ffmpegStatic, 0o755);
    }
} catch (e) {
    console.warn('[FFMPEG] Permissão ffmpeg:', e.message);
}
try {
    if (fs.existsSync(ffprobeStatic.path)) {
        fs.chmodSync(ffprobeStatic.path, 0o755);
    }
} catch (e) {
    console.warn('[FFPROBE] Permissão ffprobe:', e.message);
}

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

// Controle de Concorrência: limite padrão de 2 conversoes simultâneas
const MAX_CONCURRENT_CONVERSIONS = process.env.MAX_CONCURRENT_CONVERSIONS ? parseInt(process.env.MAX_CONCURRENT_CONVERSIONS) : 2;

// Armazenamento
// clients[batchId] = Set<Response>
const batchClients = new Map();

// batches[batchId] = { sessionId, jobs: Map<jobId, stateObject> }
const batches = new Map();

// ffmpegCommands[jobId] = command (para cancelamento)
const ffmpegCommands = new Map();

const analyzeVideo = (filePath, jobId) => {
    return new Promise((resolve, reject) => {
        console.log(`[FFPROBE] Análise iniciada - Job: ${jobId}, Arquivo: ${filePath}`);
        let finished = false;
        const timer = setTimeout(() => {
            if (!finished) {
                finished = true;
                console.warn(`[FFPROBE] Timeout (15s) excedido na análise do job ${jobId}`);
                reject(new Error('Timeout ao analisar metadados do vídeo.'));
            }
        }, 15000);

        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);

            if (err) {
                console.error(`[FFPROBE] Erro na análise - Job: ${jobId}:`, err.message || err);
                return reject(err);
            }

            try {
                const streams = metadata && metadata.streams ? metadata.streams : [];
                const videoStream = streams.find(s => s.codec_type === 'video');
                const audioStream = streams.find(s => s.codec_type === 'audio');
                const duration = metadata && metadata.format && metadata.format.duration ? parseFloat(metadata.format.duration) : null;
                const videoCodec = videoStream ? videoStream.codec_name : null;
                const audioCodec = audioStream ? audioStream.codec_name : null;

                console.log(`[FFPROBE] Análise concluída - Job: ${jobId}, Duração: ${duration}s, VideoCodec: ${videoCodec}, AudioCodec: ${audioCodec}`);
                resolve({ duration, videoCodec, audioCodec });
            } catch (parseErr) {
                console.error(`[FFPROBE] Erro ao interpretar metadados do job ${jobId}:`, parseErr);
                reject(parseErr);
            }
        });
    });
};

const notifyBatchClients = (batchId) => {
    const clients = batchClients.get(batchId);
    if (!clients || clients.size === 0) return;
    
    const batchData = batches.get(batchId);
    if (!batchData) return;
    
    // Converte os Map values para array serializável
    const batchState = Array.from(batchData.jobs.values());
    const message = `data: ${JSON.stringify(batchState)}\n\n`;
    
    clients.forEach(res => {
        res.write(message);
    });
};

const updateJobState = (batchId, jobId, stateUpdates) => {
    const batchData = batches.get(batchId);
    if (!batchData) return;
    
    const batchJobs = batchData.jobs;
    const currentState = batchJobs.get(jobId) || { jobId, batchId, progress: 0 };
    batchJobs.set(jobId, { ...currentState, ...stateUpdates });
    
    notifyBatchClients(batchId);
};

// A fila que processa os ffmpegs com controle de concorrência
const conversionQueue = async.queue(async (task) => {
    const { batchId, jobId, clientFileId, inputPath, originalName, outputPath } = task;
    console.log(`[QUEUE] Job iniciado - Lote: ${batchId}, Job: ${jobId}, Arquivo: ${originalName}`);
    
    // Antes de iniciar, verifica se o job não foi cancelado/deletado enquanto aguardava
    const batchData = batches.get(batchId);
    if (!batchData || !batchData.jobs.has(jobId)) {
        console.log(`[QUEUE] Job ignorado pois foi cancelado ou removido - Job: ${jobId}`);
        return; // Job cancelado
    }
    
    const currentState = batchData.jobs.get(jobId);
    if (currentState && currentState.status === 'Cancelado') {
        console.log(`[QUEUE] Job já cancelado - Job: ${jobId}`);
        return;
    }
    
    updateJobState(batchId, jobId, { status: 'Analisando vídeo', progress: 0 });

    let analysis = { duration: null, videoCodec: null, audioCodec: null };
    try {
        analysis = await analyzeVideo(inputPath, jobId);
    } catch (err) {
        console.error(`[JOB] Falha no FFprobe para o job ${jobId}:`, err.message || err);
        updateJobState(batchId, jobId, { status: 'Erro', error: 'Não foi possível analisar este vídeo.', progress: 0 });
        if (fs.existsSync(inputPath)) {
            try { fs.unlinkSync(inputPath); } catch (_) {}
        }
        return;
    }

    const { duration, videoCodec, audioCodec } = analysis;
    updateJobState(batchId, jobId, { status: 'Convertendo', progress: 5 });

    return new Promise((resolve) => {
        let isResolved = false;
        const finish = () => {
            if (!isResolved) {
                isResolved = true;
                clearTimeout(timeoutTimer);
                ffmpegCommands.delete(jobId);
                resolve();
            }
        };

        // Timeout de proteção para não travar a fila (10 minutos)
        const timeoutTimer = setTimeout(() => {
            console.error(`[FFMPEG] Timeout de conversão atingido (10m) - Job: ${jobId}`);
            const cmd = ffmpegCommands.get(jobId);
            if (cmd) {
                try { cmd.kill('SIGKILL'); } catch (_) {}
            }
            updateJobState(batchId, jobId, { status: 'Erro', error: 'Tempo limite de conversão excedido.', progress: 0 });
            finish();
        }, 10 * 60 * 1000);

        console.log(`[FFMPEG] Processo iniciado - Lote: ${batchId}, Job: ${jobId}, VideoCodec: ${videoCodec || 'auto'}, AudioCodec: ${audioCodec || 'auto'}`);

        let command = ffmpeg(inputPath)
            .output(outputPath)
            .outputOptions([
                '-y',                  // Sobrescreve sem perguntar
                '-nostdin',            // Desativa stdin completamente
                '-movflags +faststart' // Carregamento rápido para streaming web
            ]);

        const isDirectCopy = videoCodec === 'h264' || videoCodec === 'hevc';

        if (videoCodec === 'h264') {
            command = command.videoCodec('copy');
        } else if (videoCodec === 'hevc') {
            command = command.videoCodec('copy').outputOptions(['-tag:v hvc1']);
        } else {
            command = command.videoCodec('libx264')
                             .outputOptions(['-preset veryfast', '-crf 23']);
        }

        if (audioCodec === 'aac') {
            command = command.audioCodec('copy');
        } else {
            command = command.audioCodec('aac');
        }

        // Se for cópia direta (muito rápida), simula um progresso inicial visível
        if (isDirectCopy) {
            updateJobState(batchId, jobId, { status: 'Convertendo', progress: 50 });
        }

        command.on('progress', (progressInfo) => {
            let percent = 0;
            if (progressInfo.percent) {
                percent = progressInfo.percent;
            } else if (progressInfo.timemark && duration) {
                const a = progressInfo.timemark.split(':');
                const seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);
                percent = (seconds / duration) * 100;
            }
            percent = Math.min(Math.max(percent, 5), 99);
            updateJobState(batchId, jobId, { status: 'Convertendo', progress: percent.toFixed(1) });
        })
        .on('end', () => {
            console.log(`[FFMPEG] Processo finalizado com sucesso - Job: ${jobId}`);
            try {
                const originalStat = fs.statSync(inputPath);
                const finalStat = fs.statSync(outputPath);
                
                updateJobState(batchId, jobId, { 
                    status: 'Concluído', 
                    progress: 100,
                    originalSize: originalStat.size,
                    finalSize: finalStat.size,
                    duration: duration
                });
                console.log(`[JOB] Conversão concluída - Job: ${jobId}, Tamanho final: ${(finalStat.size / (1024*1024)).toFixed(2)} MB`);
            } catch(e) {
                console.error(`[JOB] Erro ao validar arquivo final gerado - Job: ${jobId}:`, e);
                updateJobState(batchId, jobId, { status: 'Erro', error: 'Falha ao processar arquivo final.', progress: 0 });
            } finally {
                if (fs.existsSync(inputPath)) {
                    try { fs.unlinkSync(inputPath); } catch (_) {}
                }
                finish();
            }
        })
        .on('error', (err, stdout, stderr) => {
            if (err.message && err.message.includes('SIGKILL')) {
                console.log(`[FFMPEG] Processo cancelado pelo usuário - Job: ${jobId}`);
                updateJobState(batchId, jobId, { status: 'Cancelado', progress: 0 });
            } else {
                console.error(`[FFMPEG] Erro na conversão - Job: ${jobId}:`, err.message || err);
                if (stderr) console.error(`[FFMPEG Stderr] Job ${jobId}:`, stderr);
                updateJobState(batchId, jobId, { status: 'Erro', error: 'Ocorreu um erro durante a conversão.', progress: 0 });
            }
            
            if (fs.existsSync(outputPath)) {
                try { fs.unlinkSync(outputPath); } catch (_) {}
            }
            if (fs.existsSync(inputPath)) {
                try { fs.unlinkSync(inputPath); } catch (_) {}
            }
            finish();
        });

        ffmpegCommands.set(jobId, command);
        try {
            command.run();
        } catch (runErr) {
            console.error(`[FFMPEG] Erro síncrono ao chamar command.run() - Job: ${jobId}:`, runErr);
            updateJobState(batchId, jobId, { status: 'Erro', error: 'Falha ao iniciar processo FFmpeg.', progress: 0 });
            finish();
        }
    });
}, MAX_CONCURRENT_CONVERSIONS);

const startConversion = async (batchId, sessionId, inputPath, originalName, jobId, clientFileId = null) => {
    // Verificar limites globais
    if (conversionQueue.length() + conversionQueue.running() >= MAX_GLOBAL_QUEUE) {
        console.warn(`[QUEUE] Limite global de fila atingido (${MAX_GLOBAL_QUEUE}) - Lote: ${batchId}`);
        throw { status: 503, message: 'Fila do servidor cheia. Tente mais tarde.' };
    }

    if (!batches.has(batchId)) {
        console.log(`[BATCH] Novo lote registrado - Lote: ${batchId}`);
        batches.set(batchId, { sessionId: sessionId || null, createdAt: Date.now(), jobs: new Map() });
    } else {
        console.log(`[BATCH] Lote localizado - Lote: ${batchId}`);
    }

    const batchData = batches.get(batchId);

    // Contar jobs ativos no lote para evitar spam excessivo
    let activeBatchJobs = 0;
    for (const jState of batchData.jobs.values()) {
        if (['Aguardando', 'Analisando vídeo', 'Convertendo', 'Pendente', 'Enviando'].includes(jState.status)) {
            activeBatchJobs++;
        }
    }

    if (activeBatchJobs >= MAX_USER_ACTIVE_JOBS) {
        console.warn(`[BATCH] Limite de jobs por lote atingido (${MAX_USER_ACTIVE_JOBS}) - Lote: ${batchId}`);
        throw { status: 429, message: `Limite de ${MAX_USER_ACTIVE_JOBS} vídeos simultâneos por lote atingido.` };
    }

    const outputPath = path.join(path.dirname(inputPath), `${jobId}.mp4`);
    
    // Inicializa o estado
    batchData.jobs.set(jobId, { 
        jobId, 
        clientFileId,
        batchId,
        status: 'Aguardando', 
        progress: 0, 
        originalName,
        inputPath,
        outputPath
    });

    console.log(`[JOB] Job criado - Lote: ${batchId}, Job: ${jobId}, Arquivo: ${originalName}`);
    notifyBatchClients(batchId);

    // Envia para a fila
    console.log(`[QUEUE] Job adicionado à fila - Lote: ${batchId}, Job: ${jobId}`);
    conversionQueue.push({ batchId, jobId, clientFileId, inputPath, originalName, outputPath });
    
    return jobId;
};

const cancelConversion = (batchId, jobId, sessionId) => {
    const batchData = batches.get(batchId);
    if (!batchData || !batchData.jobs.has(jobId)) return false;
    
    const jobState = batchData.jobs.get(jobId);
    
    // Se está na fila e não começou, apenas marcamos cancelado para pular
    if (jobState.status === 'Aguardando') {
        updateJobState(batchId, jobId, { status: 'Cancelado' });
        // Limpar o temporário original
        if (fs.existsSync(jobState.inputPath)) {
            try { fs.unlinkSync(jobState.inputPath); } catch (_) {}
        }
        return true;
    }
    
    // Se está convertendo, encerra o processo FFmpeg
    if (jobState.status === 'Analisando vídeo' || jobState.status === 'Convertendo') {
        const command = ffmpegCommands.get(jobId);
        if (command) {
            command.kill('SIGKILL');
        }
        updateJobState(batchId, jobId, { status: 'Cancelado' });
        if (fs.existsSync(jobState.inputPath)) {
            try { fs.unlinkSync(jobState.inputPath); } catch (_) {}
        }
        return true;
    }
    
    return false;
};

const getBatchProgress = (req, res) => {
    const batchId = req.params.batchId;
    const batchData = batches.get(batchId);
    console.log(`[SSE] Cliente conectado ao lote: ${batchId}`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    if (!batchClients.has(batchId)) {
        batchClients.set(batchId, new Set());
    }
    const clients = batchClients.get(batchId);
    clients.add(res);

    // Envia o estado atual imediatamente
    if (batchData) {
        const batchState = Array.from(batchData.jobs.values());
        res.write(`data: ${JSON.stringify(batchState)}\n\n`);
        console.log(`[SSE] Evento transmitido (estado inicial) - Lote: ${batchId}, Jobs: ${batchState.length}`);
    } else {
        res.write(`data: []\n\n`);
    }

    // Heartbeat a cada 15 segundos para manter a conexão ativa através de proxies e roteadores
    const heartbeatTimer = setInterval(() => {
        if (!res.writableEnded) {
            res.write(': heartbeat\n\n');
        }
    }, 15000);

    req.on('close', () => {
        clearInterval(heartbeatTimer);
        clients.delete(res);
        console.log(`[SSE] Cliente desconectado do lote: ${batchId}`);
        if (clients.size === 0) {
            batchClients.delete(batchId);
        }
    });
};

const downloadFile = (req, res) => {
    const { batchId, jobId } = req.params;
    const outputPath = path.join(__dirname, '../../tmp', `${jobId}.mp4`);
    
    if (fs.existsSync(outputPath)) {
        const batchData = batches.get(batchId);
        if (batchData && batchData.jobs.has(jobId)) {
            const jobState = batchData.jobs.get(jobId);
            const downloadName = jobState.originalName.replace(/\.mov$/i, '.mp4');
            console.log(`[DOWNLOAD] Arquivo disponível para download - Job: ${jobId}, Arquivo: ${downloadName}`);
            return res.download(outputPath, downloadName, (err) => {
                if (err && !res.headersSent) {
                    res.status(500).json({ error: 'Erro ao fazer download do arquivo.' });
                }
            });
        }
        return res.status(403).json({ error: 'Acesso negado ou lote inválido.' });
    } else {
        res.status(404).json({ error: 'O arquivo expirou ou não existe.' });
    }
};

const downloadZip = (req, res) => {
    const batchId = req.params.batchId;
    const batchData = batches.get(batchId);
    
    if (!batchData) {
        return res.status(404).json({ error: 'Lote não encontrado ou expirado.' });
    }

    const filesToZip = [];
    for (const jobState of batchData.jobs.values()) {
        if (jobState.status === 'Concluído' && fs.existsSync(jobState.outputPath)) {
            filesToZip.push({
                path: jobState.outputPath,
                name: jobState.originalName.replace(/\.mov$/i, '.mp4')
            });
        }
    }

    if (filesToZip.length === 0) {
        return res.status(400).json({ error: 'Nenhum arquivo concluído para adicionar ao ZIP.' });
    }

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="Conversor5M-${batchId}.zip"`);

    const archive = new ZipArchive({
        zlib: { level: 0 } // Level 0 para ser rápido, vídeo já é comprimido
    });

    archive.on('error', (err) => {
        if (!res.headersSent) res.status(500).json({ error: 'Erro gerando ZIP' });
    });

    archive.pipe(res);

    filesToZip.forEach(file => {
        archive.file(file.path, { name: file.name });
    });

    archive.finalize();
};

module.exports = { startConversion, cancelConversion, getBatchProgress, downloadFile, downloadZip, batches, batchClients, ffmpegCommands };
