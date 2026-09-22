const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs');
const async = require('async');
const { ZipArchive } = require('archiver');

if (process.env.FFMPEG_PATH) ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
if (process.env.FFPROBE_PATH) ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);

// Controle de Concorrência: limite padrão de 2 conversoes simultâneas
const MAX_CONCURRENT_CONVERSIONS = process.env.MAX_CONCURRENT_CONVERSIONS ? parseInt(process.env.MAX_CONCURRENT_CONVERSIONS) : 2;

// Armazenamento
// clients[batchId] = Set<Response>
const batchClients = new Map();

// batches[batchId] = Map<jobId, stateObject>
const batches = new Map();

// ffmpegCommands[jobId] = command (para cancelamento)
const ffmpegCommands = new Map();

const getDuration = (filePath) => {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) return reject(err);
            resolve(metadata.format.duration);
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
        res.write(message);
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
    
    // Antes de iniciar, verifica se o job não foi cancelado/deletado enquanto aguardava
    const batchJobs = batches.get(batchId);
    if (!batchJobs || !batchJobs.has(jobId)) {
        return; // Job cancelado
    }
    
    const currentState = batchJobs.get(jobId);
    if (currentState && currentState.status === 'Cancelado') return;
    
    updateJobState(batchId, jobId, { status: 'Analisando vídeo', progress: 0 });

    let duration;
    try {
        duration = await getDuration(inputPath);
    } catch (err) {
        console.error(`Erro ffprobe no job ${jobId}:`, err);
        updateJobState(batchId, jobId, { status: 'Erro', error: 'Não foi possível analisar este vídeo.', progress: 0 });
        return;
    }

    updateJobState(batchId, jobId, { status: 'Convertendo', progress: 0 });

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

const startConversion = async (batchId, inputPath, originalName, jobId) => {
    const outputPath = path.join(path.dirname(inputPath), `${jobId}.mp4`);
    
    // Inicializa o estado
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
    const batchJobs = batches.get(batchId);
    if (!batchJobs || !batchJobs.has(jobId)) return false;
    
    const jobState = batchJobs.get(jobId);
    
    // Se está na fila e não começou, apenas marcamos cancelado para pular
    if (jobState.status === 'Aguardando') {
        updateJobState(batchId, jobId, { status: 'Cancelado' });
        // Limpar o temporário original
        if (fs.existsSync(jobState.inputPath)) fs.unlinkSync(jobState.inputPath);
        return true;
    }
    
    // Se está convertendo, mata o FFmpeg
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
    
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    if (!batchClients.has(batchId)) {
        batchClients.set(batchId, new Set());
    }
    const clients = batchClients.get(batchId);
    clients.add(res);

    // Envia o estado atual imediatamente
    const batchJobs = batches.get(batchId);
    if (batchJobs) {
        const batchState = Array.from(batchJobs.values());
        res.write(`data: ${JSON.stringify(batchState)}\n\n`);
    } else {
        res.write(`data: []\n\n`);
    }

    req.on('close', () => {
        clients.delete(res);
        if (clients.size === 0) {
            batchClients.delete(batchId);
        }
    });
};

const downloadFile = (req, res) => {
    const jobId = req.params.id;
    const outputPath = path.join(__dirname, '../../tmp', `${jobId}.mp4`);
    
    if (fs.existsSync(outputPath)) {
        // Precisamos encontrar o nome original vasculhando os lotes, ou enviar nome genérico.
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
                res.status(500).json({ error: 'Erro ao fazer download do arquivo.' });
            }
        });
    } else {
        res.status(404).json({ error: 'O arquivo expirou ou não existe.' });
    }
};

const downloadZip = (req, res) => {
    const batchId = req.params.batchId;
    const batchJobs = batches.get(batchId);
    
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
