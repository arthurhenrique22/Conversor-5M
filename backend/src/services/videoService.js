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

const analyzeVideo = (filePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            const videoStream = metadata.streams.find(s => s.codec_type === 'video');
            const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
            resolve({
                duration: metadata.format.duration,
                videoCodec: videoStream ? videoStream.codec_name : null,
                audioCodec: audioStream ? audioStream.codec_name : null,
            });
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
    const { batchId, jobId, inputPath, originalName, outputPath } = task;
    
    // Antes de iniciar, verifica se o job não foi cancelado/deletado enquanto aguardava
    const batchData = batches.get(batchId);
    if (!batchData || !batchData.jobs.has(jobId)) {
        return; // Job cancelado
    }
    
    const currentState = batchData.jobs.get(jobId);
    if (currentState && currentState.status === 'Cancelado') return;
    
    updateJobState(batchId, jobId, { status: 'Analisando vídeo', progress: 0 });

    let analysis;
    try {
        analysis = await analyzeVideo(inputPath);
    } catch (err) {
        console.error(`Erro ffprobe no job ${jobId}:`, err);
        updateJobState(batchId, jobId, { status: 'Erro', error: 'Não foi possível analisar este vídeo.', progress: 0 });
        return;
    }

    const { duration, videoCodec, audioCodec } = analysis;
    updateJobState(batchId, jobId, { status: 'Convertendo', progress: 0 });

    return new Promise((resolve) => {
        let command = ffmpeg(inputPath).output(outputPath);

        // Otimização: se o codec de vídeo for h264 ou hevc, não precisa recodificar, apenas copiar o stream
        if (videoCodec === 'h264') {
            command = command.videoCodec('copy');
        } else if (videoCodec === 'hevc') {
            // Tag hvc1 garante compatibilidade do MP4 com Apple QuickTime, iPhone e Safari
            command = command.videoCodec('copy').outputOptions(['-tag:v hvc1']);
        } else {
            command = command.videoCodec('libx264')
                             .outputOptions(['-preset veryfast', '-crf 23']);
        }

        // Otimização: se o codec de áudio já for aac, copiar
        if (audioCodec === 'aac') {
            command = command.audioCodec('copy');
        } else {
            command = command.audioCodec('aac');
        }

        command = command.outputOptions(['-movflags +faststart']);

        command.on('progress', (progressInfo) => {
                let percent = 0;
                if (progressInfo.percent) {
                    percent = progressInfo.percent;
                } else if (progressInfo.timemark && duration) {
                    const a = progressInfo.timemark.split(':');
                    const seconds = (+a[0]) * 60 * 60 + (+a[1]) * 60 + (+a[2]);
                    percent = (seconds / duration) * 100;
                }
                percent = Math.min(Math.max(percent, 0), 99);
                updateJobState(batchId, jobId, { status: 'Convertendo', progress: percent.toFixed(1) });
            })
            .on('end', () => {
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
                } catch(e) {
                    updateJobState(batchId, jobId, { status: 'Erro', error: 'Falha ao processar arquivo final.', progress: 0 });
                } finally {
                    ffmpegCommands.delete(jobId);
                    resolve();
                }
            })
            .on('error', (err, stdout, stderr) => {
                if (err.message && err.message.includes('SIGKILL')) {
                    updateJobState(batchId, jobId, { status: 'Cancelado', progress: 0 });
                } else {
                    console.error('Erro na conversão FFmpeg:', err);
                    updateJobState(batchId, jobId, { status: 'Erro', error: 'Ocorreu um erro durante a conversão.', progress: 0 });
                }
                
                ffmpegCommands.delete(jobId);
                if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath);
                resolve();
            });

        ffmpegCommands.set(jobId, command);
        command.run();
    });
}, MAX_CONCURRENT_CONVERSIONS);

const startConversion = async (batchId, sessionId, inputPath, originalName, jobId) => {
    // Verificar limites globais
    if (conversionQueue.length() + conversionQueue.running() >= MAX_GLOBAL_QUEUE) {
        throw { status: 503, message: 'Fila do servidor cheia. Tente mais tarde.' };
    }

    if (!batches.has(batchId)) {
        batches.set(batchId, { sessionId: sessionId || null, createdAt: Date.now(), jobs: new Map() });
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
        throw { status: 429, message: `Limite de ${MAX_USER_ACTIVE_JOBS} vídeos simultâneos por lote atingido.` };
    }

    const outputPath = path.join(path.dirname(inputPath), `${jobId}.mp4`);
    
    // Inicializa o estado
    batchData.jobs.set(jobId, { 
        jobId, batchId,
        status: 'Aguardando', 
        progress: 0, 
        originalName,
        inputPath,
        outputPath
    });

    notifyBatchClients(batchId);

    // Envia para a fila
    conversionQueue.push({ batchId, jobId, inputPath, originalName, outputPath });
    
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
        if (fs.existsSync(jobState.inputPath)) fs.unlinkSync(jobState.inputPath);
        return true;
    }
    
    // Se está convertendo, encerra o processo FFmpeg
    if (jobState.status === 'Analisando vídeo' || jobState.status === 'Convertendo') {
        const command = ffmpegCommands.get(jobId);
        if (command) {
            command.kill('SIGKILL');
        }
        updateJobState(batchId, jobId, { status: 'Cancelado' });
        if (fs.existsSync(jobState.inputPath)) fs.unlinkSync(jobState.inputPath);
        return true;
    }
    
    return false;
};

const getBatchProgress = (req, res) => {
    const batchId = req.params.batchId;
    const batchData = batches.get(batchId);

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
