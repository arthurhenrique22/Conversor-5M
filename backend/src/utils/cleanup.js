const fs = require('fs');
const path = require('path');
const { batches, batchClients } = require('../services/videoService');

const tmpDir = path.join(__dirname, '../../tmp');

// Retenção em minutos (30 por padrão)
const RETENTION_MINUTES = process.env.FILE_RETENTION_MINUTES ? parseInt(process.env.FILE_RETENTION_MINUTES) : 30;
const RETENTION_MS = RETENTION_MINUTES * 60 * 1000;

const cleanupFiles = () => {
    if (!fs.existsSync(tmpDir)) return;

    const files = fs.readdirSync(tmpDir);
    const now = Date.now();

    files.forEach(file => {
        const filePath = path.join(tmpDir, file);
        const stats = fs.statSync(filePath);

        const ageMs = now - stats.mtimeMs;
        if (ageMs > RETENTION_MS) {
            try {
                fs.unlinkSync(filePath);
                console.log(`[Limpeza] Arquivo antigo removido: ${file}`);
            } catch (err) {
                console.error(`[Limpeza] Erro ao remover ${file}:`, err);
            }
        }
    });
};

const cleanupMemory = () => {
    const now = Date.now();
    for (const [batchId, bData] of batches.entries()) {
        if (bData.createdAt && (now - bData.createdAt > RETENTION_MS)) {
            batches.delete(batchId);
            batchClients.delete(batchId);
            console.log(`[Limpeza RAM] Metadados do lote expirado removidos: ${batchId}`);
        }
    }
};

const startCleanupCron = () => {
    // Roda a cada 5 minutos
    setInterval(() => {
        cleanupFiles();
        cleanupMemory();
    }, 5 * 60 * 1000);
    console.log('[Sistema] Cron de limpeza iniciado.');
};

module.exports = { startCleanupCron };
