const fs = require('fs');
const path = require('path');

const tmpDir = path.join(__dirname, '../../tmp');

// Limites globais
const MAX_GLOBAL_STORAGE_BYTES = process.env.MAX_GLOBAL_STORAGE_BYTES ? parseInt(process.env.MAX_GLOBAL_STORAGE_BYTES) : 5 * 1024 * 1024 * 1024; // 5GB
const MAX_GLOBAL_QUEUE = process.env.MAX_GLOBAL_QUEUE ? parseInt(process.env.MAX_GLOBAL_QUEUE) : 50; 
const MAX_USER_ACTIVE_JOBS = process.env.MAX_USER_ACTIVE_JOBS ? parseInt(process.env.MAX_USER_ACTIVE_JOBS) : 10;

let cachedDirSize = 0;
let lastCheck = 0;

const getTmpDirSize = async () => {
    const now = Date.now();
    if (now - lastCheck < 5000) { // Cache por 5 segundos
        return cachedDirSize;
    }

    let totalSize = 0;
    try {
        if (!fs.existsSync(tmpDir)) return 0;
        const files = fs.readdirSync(tmpDir);
        for (const file of files) {
            const stats = fs.statSync(path.join(tmpDir, file));
            totalSize += stats.size;
        }
        cachedDirSize = totalSize;
        lastCheck = now;
    } catch (err) {
        console.error('Erro ao ler tamanho do diretório tmp:', err);
    }
    
    return cachedDirSize;
};

const checkStorageLimit = async (req, res, next) => {
    const currentSize = await getTmpDirSize();
    // Rejeitar se estiver em 90% para dar folga aos uploads em andamento e conversoes
    if (currentSize > MAX_GLOBAL_STORAGE_BYTES * 0.9) {
        return res.status(503).json({ error: 'Servidor no limite de armazenamento. Tente novamente em alguns minutos.' });
    }
    next();
};

module.exports = {
    getTmpDirSize,
    checkStorageLimit,
    MAX_GLOBAL_QUEUE,
    MAX_USER_ACTIVE_JOBS
};
