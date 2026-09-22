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
    // Também limpa metadados de lotes que já expiraram para não estourar RAM
    // Consideramos "expirado" se não tem conexões SSE e a última atividade foi muito antiga, mas sem um timestamp exato é difícil.
    // Vamos varrer os lotes, se não tiver cliente pendente, verificamos se todos os arquivos estão "Concluído", "Erro" ou "Cancelado".
    // Se a idade pudesse ser rastreada seria melhor, mas podemos usar o próprio garbage collection ao remover.
    // Como simplificação: limpar a memória é seguro após algumas horas, mas podemos ignorar neste MVP ou implementar algo simples
    
    // Deixaremos para o MVP a limpeza apenas de arquivos físicos, o mapa cresce devagar (apenas nomes). 
};

const startCleanupCron = () => {
    // Roda a cada 5 minutos
    setInterval(() => {
        cleanupFiles();
    }, 5 * 60 * 1000);
    console.log('[Sistema] Cron de limpeza iniciado.');
};

module.exports = { startCleanupCron };
