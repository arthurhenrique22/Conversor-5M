const ffmpeg = require('fluent-ffmpeg');
const ffmpegStatic = require('ffmpeg-static');
const ffprobeStatic = require('ffprobe-static');
const path = require('path');
const fs = require('fs');
const async = require('async');
const { ZipArchive } = require('archiver');

// Set static paths explicitly
ffmpeg.setFfmpegPath(ffmpegStatic);
ffmpeg.setFfprobePath(ffprobeStatic.path);

console.log('[FFMPEG] ffmpeg path:', ffmpegStatic);
console.log('[FFMPEG] ffprobe path:', ffprobeStatic.path);

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

// Controle de Concorrência: limite padrão de 2 conversoes simultâneas
const MAX_CONCURRENT_CONVERSIONS = process.env.MAX_CONCURRENT_CONVERSIONS ? parseInt(process.env.MAX_CONCURRENT_CONVERSIONS, 10) : 2;

// Armazenamento em memória
// clients[batchId] = Set<Response>
const batchClients = new Map();

// batches[batchId] = Map<jobId, stateObject>
const batches = new Map();

// ffmpegCommands[jobId] = command (para cancelamento)
const ffmpegCommands = new Map();

// Converte timemark (HH:MM:SS.microsegundos) para microssegundos inteiros
const parseTimemarkToMicroseconds = (timemark) => {
    if (!timemark || typeof timemark !== 'string') return 0;
    const parts = timemark.split(':');
    if (parts.length === 3) {
        const hours = parseFloat(parts[0]) || 0;
        const minutes = parseFloat(parts[1]) || 0;
        const seconds = parseFloat(parts[2]) || 0;
        return Math.round(((hours * 3600) + (minutes * 60) + seconds) * 1_000_000);
    }
    return 0;
};

const getDuration = (filePath) => {
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Timeout de 30s ao analisar metadados com ffprobe.'));
        }, 30000);

        ffmpeg.ffprobe(filePath, (err, metadata) => {
            clearTimeout(timeout);
            if (err) return reject(err);

            let duration = metadata?.format?.duration;
            if (!duration && metadata?.streams) {
                const videoStream = metadata.streams.find(s => s.codec_type === 'video');
                duration = videoStream?.duration;
            }

            const parsed = duration ? parseFloat(duration) : null;
            resolve(parsed && Number.isFinite(parsed) && parsed > 0 ? parsed : null);
        });
    });
};

const notifyBatchClients = (batchId) => {
    const clients = batchClients.get(batchId);
    if (!clients || clients.size === 0) return;
    
    const batchJobs = batches.get(batchId);
    if (!batchJobs) return;
    
    // Converte os Map values para array serializável
    const batchState = Array.from(batchJobs.values());
    const message = `data: ${JSON.stringify(batchState)}\n\n`;
    
    clients.forEach(res => {
        try {
            res.write(message);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] [SSE] Falha ao enviar evento para cliente:`, err.message);
        }
    });
};

const updateJobState = (batchId, jobId, stateUpdates) => {
    if (!batches.has(batchId)) {
        batches.set(batchId, new Map());
    }
    const batchJobs = batches.get(batchId);
    const currentState = batchJobs.get(jobId) || { jobId, batchId, progress: 0 };
    batchJobs.set(jobId, { ...currentState, ...stateUpdates });
    
    notifyBatchClients(batchId);
};

// A fila que processa os ffmpegs com controle de concorrência
const conversionQueue = async.queue(async (task) => {
    const { batchId, jobId, inputPath, originalName, outputPath } = task;
    const taskStartTime = Date.now();
    
    console.log(`[${new Date().toISOString()}] [FILA PROCESSANDO] Início da conversão | Job: ${jobId} | Lote: ${batchId} | Arquivo: "${originalName}" | Restantes na fila: ${conversionQueue.length()}`);

    // Antes de iniciar, verifica se o job não foi cancelado/deletado enquanto aguardava
    const batchJobs = batches.get(batchId);
    if (!batchJobs || !batchJobs.has(jobId)) {
        console.log(`[${new Date().toISOString()}] [FILA PULANDO] Job ${jobId} cancelado antes do início.`);
        return;
    }
    
    const currentState = batchJobs.get(jobId);
    if (currentState && currentState.status === 'Cancelado') {
        console.log(`[${new Date().toISOString()}] [FILA PULANDO] Job ${jobId} marcado como Cancelado.`);
        return;
    }
    
    updateJobState(batchId, jobId, { 
        status: 'Analisando vídeo', 
        progress: 0,
        startTime: taskStartTime
    });

    let duration = null;
    try {
        console.log(`[${new Date().toISOString()}] [FFPROBE INÍCIO] Analisando metadados: ${inputPath}`);
        duration = await getDuration(inputPath);
        console.log(`[${new Date().toISOString()}] [FFPROBE FIM] Metadados analisados com sucesso | Duração: ${duration ? duration.toFixed(2) + 's' : 'Desconhecida'}`);
    } catch (err) {
        console.error(`[${new Date().toISOString()}] [FFPROBE ERRO] Falha no job ${jobId}:`, err.message);
        updateJobState(batchId, jobId, { 
            status: 'Erro', 
            error: 'Não foi possível analisar o arquivo MOV enviado.', 
            progress: 0 
        });
        return;
    }

    updateJobState(batchId, jobId, { 
        status: 'Convertendo', 
        progress: 0,
        totalDuration: duration
    });
    
    console.log(`[${new Date().toISOString()}] [FFMPEG INÍCIO] Transcodificação iniciada -> ${outputPath} | Codec: libx264/aac | Preset: fast`);

    let lastLoggedPercent = -1;
    let lastLogTime = Date.now();

    return new Promise((resolve) => {
        const command = ffmpeg(inputPath)
            .output(outputPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .outputOptions([
                '-movflags +faststart',
                '-preset fast',
                '-crf 23'
            ])
            .on('progress', (progressInfo) => {
                let percent = 0;
                let currentVideoSec = 0;

                // Cálculo preciso baseado na fórmula: percentual = out_time_us / (duracaoEmSegundos * 1_000_000) * 100
                if (progressInfo.timemark && duration && duration > 0) {
                    const outTimeUs = parseTimemarkToMicroseconds(progressInfo.timemark);
                    const totalDurationUs = duration * 1_000_000;
                    percent = (outTimeUs / totalDurationUs) * 100;
                    currentVideoSec = (outTimeUs / 1_000_000).toFixed(1);
                } else if (progressInfo.percent) {
                    percent = progressInfo.percent;
                }

                if (isNaN(percent) || !Number.isFinite(percent) || percent < 0) {
                    percent = 0;
                }
                // Limita a 99% durante a execução ativa; 100% é reservado exclusivamente para Concluído
                percent = Math.min(percent, 99.0);

                const elapsedSeconds = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                const currentPercentInt = Math.floor(percent);
                const now = Date.now();

                if (currentPercentInt >= lastLoggedPercent + 10 || (now - lastLogTime > 5000 && currentPercentInt > lastLoggedPercent)) {
                    lastLoggedPercent = currentPercentInt;
                    lastLogTime = now;
                    const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
                    console.log(`[${new Date().toISOString()}] [FFMPEG PROGRESSO] Job: ${jobId} | ${percent.toFixed(1)}% | Timemark: ${progressInfo.timemark || 'N/A'} | Decorrido: ${elapsedSeconds}s | RAM RSS: ${memMb} MB`);
                }

                updateJobState(batchId, jobId, { 
                    status: 'Convertendo', 
                    progress: parseFloat(percent.toFixed(1)),
                    timemark: progressInfo.timemark || null,
                    currentTime: currentVideoSec,
                    elapsedSeconds: parseFloat(elapsedSeconds)
                });
            })
            .on('end', () => {
                // Etapa "Finalizando arquivo": o FFmpeg concluiu a transcodificação e o arquivo está sendo fechado em disco
                const elapsedBeforeCheck = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                updateJobState(batchId, jobId, { 
                    status: 'Finalizando arquivo', 
                    progress: 99.5,
                    elapsedSeconds: parseFloat(elapsedBeforeCheck)
                });

                try {
                    const originalStat = fs.statSync(inputPath);
                    const finalStat = fs.statSync(outputPath);
                    const elapsed = ((Date.now() - taskStartTime) / 1000).toFixed(1);
                    const originalMb = (originalStat.size / (1024 * 1024)).toFixed(2);
                    const finalMb = (finalStat.size / (1024 * 1024)).toFixed(2);
                    const savedPercent = originalStat.size > 0 
                        ? (((originalStat.size - finalStat.size) / originalStat.size) * 100).toFixed(1)
                        : '0';

                    console.log(`[${new Date().toISOString()}] [FFMPEG CONCLUÍDO] Job: ${jobId} em ${elapsed}s | Original: ${originalMb} MB -> MP4: ${finalMb} MB (${savedPercent}% comprimido)`);

                    // Concluído com sucesso: arquivo 100% pronto para download
                    updateJobState(batchId, jobId, { 
                        status: 'Concluído', 
                        progress: 100,
                        originalSize: originalStat.size,
                        finalSize: finalStat.size,
                        duration: duration,
                        elapsedSeconds: parseFloat(elapsed)
                    });
                } catch(e) {
                    console.error(`[${new Date().toISOString()}] [FFMPEG ERRO PÓS-PROCESSAMENTO] Job: ${jobId}:`, e.message);
                    updateJobState(batchId, jobId, { 
                        status: 'Erro', 
                        error: 'Falha ao validar o arquivo final convertido.', 
                        progress: 0 
                    });
                } finally {
                    ffmpegCommands.delete(jobId);
                    resolve();
                }
            })
            .on('error', (err, stdout, stderr) => {
                if (err.message && err.message.includes('SIGKILL')) {
                    console.log(`[${new Date().toISOString()}] [FFMPEG CANCELADO] Job: ${jobId} interrompido por solicitação do usuário.`);
                    updateJobState(batchId, jobId, { status: 'Cancelado', progress: 0 });
                } else {
                    console.error(`[${new Date().toISOString()}] [FFMPEG ERRO DE CONVERSÃO] Job: ${jobId}:`, err.message);
                    updateJobState(batchId, jobId, { status: 'Erro', error: 'Ocorreu um erro durante a conversão do vídeo.', progress: 0 });
                }
                
                ffmpegCommands.delete(jobId);
                if (fs.existsSync(outputPath)) {
                    try { fs.unlinkSync(outputPath); } catch (_) {}
                }
                resolve();
            });

        ffmpegCommands.set(jobId, command);
        command.run();
    });
}, MAX_CONCURRENT_CONVERSIONS);

const startConversion = async (batchId, inputPath, originalName, jobId) => {
    const outputPath = path.join(path.dirname(inputPath), `${jobId}.mp4`);
    
    console.log(`[${new Date().toISOString()}] [FILA ENFILEIRANDO] Lote: ${batchId} | Job: ${jobId} | Arquivo: "${originalName}"`);

    // Inicializa o estado como "Aguardando" na fila
    updateJobState(batchId, jobId, { 
        status: 'Aguardando', 
        progress: 0, 
        originalName,
        inputPath,
        outputPath
    });

    // Envia para a fila
    conversionQueue.push({ batchId, jobId, inputPath, originalName, outputPath });
    
    return jobId;
};

const cancelConversion = (batchId, jobId) => {
    console.log(`[${new Date().toISOString()}] [CANCELAMENTO SOLICITADO] Lote: ${batchId} | Job: ${jobId}`);
    const batchJobs = batches.get(batchId);
    if (!batchJobs || !batchJobs.has(jobId)) return false;
    
    const jobState = batchJobs.get(jobId);
    
    // Se está na fila e não começou, apenas marcamos cancelado para pular
    if (jobState.status === 'Aguardando') {
        updateJobState(batchId, jobId, { status: 'Cancelado' });
        if (fs.existsSync(jobState.inputPath)) {
            try { fs.unlinkSync(jobState.inputPath); } catch (_) {}
        }
        console.log(`[${new Date().toISOString()}] [CANCELADO NA FILA] Job: ${jobId} cancelado antes do início.`);
        return true;
    }
    
    // Se está convertendo, mata o FFmpeg
    if (['Analisando vídeo', 'Convertendo', 'Finalizando arquivo'].includes(jobState.status)) {
        const command = ffmpegCommands.get(jobId);
        if (command) {
            command.kill('SIGKILL');
        }
        updateJobState(batchId, jobId, { status: 'Cancelado' });
        if (fs.existsSync(jobState.inputPath)) {
            try { fs.unlinkSync(jobState.inputPath); } catch (_) {}
        }
        console.log(`[${new Date().toISOString()}] [CANCELADO EM PROCESSAMENTO] Processo FFmpeg do job ${jobId} encerrado.`);
        return true;
    }
    
    return false;
};

// Endpoint REST para consulta imediata de status do lote (sincronização instantânea ao voltar à aba)
const getBatchStatus = (req, res) => {
    const batchId = req.params.batchId;
    const batchJobs = batches.get(batchId);
    
    if (!batchJobs) {
        return res.status(200).json({ batchId, jobs: [] });
    }
    
    const jobs = Array.from(batchJobs.values());
    res.status(200).json({ batchId, jobs });
};

const getBatchProgress = (req, res) => {
    const batchId = req.params.batchId;
    const origin = req.headers.origin;
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Desativa buffering em Nginx e proxies como Railway

    if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }

    res.flushHeaders();

    if (!batchClients.has(batchId)) {
        batchClients.set(batchId, new Set());
    }
    const clients = batchClients.get(batchId);
    clients.add(res);

    console.log(`[${new Date().toISOString()}] [SSE CLIENTE CONECTADO] Lote: ${batchId} | Total de clientes no lote: ${clients.size}`);

    // Heartbeat periódico (a cada 25s) para manter a conexão ativa em proxies
    const heartbeatTimer = setInterval(() => {
        try {
            res.write(': heartbeat\n\n');
        } catch (e) {
            clearInterval(heartbeatTimer);
        }
    }, 25000);

    // Envia o estado atual imediatamente
    const batchJobs = batches.get(batchId);
    if (batchJobs) {
        const batchState = Array.from(batchJobs.values());
        res.write(`data: ${JSON.stringify(batchState)}\n\n`);
    } else {
        res.write(`data: []\n\n`);
    }

    req.on('close', () => {
        clearInterval(heartbeatTimer);
        clients.delete(res);
        console.log(`[${new Date().toISOString()}] [SSE CLIENTE DESCONECTADO] Lote: ${batchId} | Restantes: ${clients.size}`);
        if (clients.size === 0) {
            batchClients.delete(batchId);
        }
    });
};

const downloadFile = (req, res) => {
    const jobId = req.params.id;
    const tmpDir = path.join(__dirname, '../../tmp');
    const outputPath = path.join(tmpDir, `${jobId}.mp4`);
    
    console.log(`[${new Date().toISOString()}] [DOWNLOAD ARQUIVO] Solicitado para job: ${jobId}`);

    if (fs.existsSync(outputPath)) {
        let downloadName = `${jobId}.mp4`;
        for (const [bId, bJobs] of batches.entries()) {
            if (bJobs.has(jobId)) {
                const jobState = bJobs.get(jobId);
                downloadName = jobState.originalName.replace(/\.mov$/i, '.mp4');
                break;
            }
        }
            
        res.download(outputPath, downloadName, (err) => {
            if (err && !res.headersSent) {
                console.error(`[${new Date().toISOString()}] [DOWNLOAD ERRO] Job: ${jobId}:`, err.message);
                res.status(500).json({ error: 'Erro ao fazer download do arquivo.' });
            }
        });
    } else {
        console.warn(`[${new Date().toISOString()}] [DOWNLOAD NÃO ENCONTRADO] Arquivo não existe em: ${outputPath}`);
        res.status(404).json({ error: 'O arquivo expirou ou não existe no servidor.' });
    }
};

const downloadZip = (req, res) => {
    const batchId = req.params.batchId;
    const batchJobs = batches.get(batchId);
    
    console.log(`[${new Date().toISOString()}] [DOWNLOAD ZIP] Solicitado para lote: ${batchId}`);

    if (!batchJobs) {
        return res.status(404).json({ error: 'Lote não encontrado.' });
    }

    const filesToZip = [];
    for (const jobState of batchJobs.values()) {
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
        zlib: { level: 0 }
    });

    archive.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] [DOWNLOAD ZIP ERRO]:`, err.message);
        if (!res.headersSent) res.status(500).json({ error: 'Erro gerando ZIP' });
    });

    archive.pipe(res);

    filesToZip.forEach(file => {
        archive.file(file.path, { name: file.name });
    });

    archive.finalize();
};

module.exports = { 
    startConversion, 
    cancelConversion, 
    getBatchProgress, 
    getBatchStatus,
    downloadFile, 
    downloadZip, 
    batches, 
    batchClients, 
    ffmpegCommands 
};
