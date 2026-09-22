require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { upload } = require('./src/middlewares/upload');
const { startConversion, cancelConversion, getBatchProgress, downloadFile, downloadZip } = require('./src/services/videoService');
const { startCleanupCron } = require('./src/utils/cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

// Configurar CORS
const corsOptions = {
    origin: process.env.FRONTEND_URL || '*',
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
};
app.use(cors(corsOptions));
app.use(express.json());

// Garantir que a pasta tmp existe
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Iniciar cron job de limpeza
startCleanupCron();

// Rotas da API

// Upload atrelado a um lote
app.post('/api/upload/:batchId', upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado ou formato inválido. Use um arquivo MOV.' });
    }

    const batchId = req.params.batchId;
    const jobId = crypto.randomUUID(); // Usamos um novo uuid limpo pro job
    // Se quiser reutilizar o filename do multer pro job, também serve.
    // O multer gerou req.file.filename, vamos usá-lo como jobId já que ele já foi gerado
    const actualJobId = path.parse(req.file.filename).name; 
    
    try {
        await startConversion(batchId, req.file.path, req.file.originalname, actualJobId);
        res.json({ jobId: actualJobId, batchId: batchId, originalName: req.file.originalname, message: 'Adicionado à fila' });
    } catch (error) {
        console.error('Erro ao iniciar conversão:', error);
        res.status(500).json({ error: 'Falha ao processar o vídeo.' });
    }
});

app.post('/api/cancel/:batchId/:jobId', (req, res) => {
    const { batchId, jobId } = req.params;
    const cancelled = cancelConversion(batchId, jobId);
    if (cancelled) {
        res.json({ success: true, message: 'Processo cancelado' });
    } else {
        res.status(404).json({ error: 'Processo não encontrado ou não pôde ser cancelado' });
    }
});

app.get('/api/progress/batch/:batchId', getBatchProgress);

app.get('/api/download/:id', downloadFile);

app.get('/api/download/batch/:batchId/zip', downloadZip);

// Error handling middleware (e.g., multer errors)
app.use((err, req, res, next) => {
    if (err) {
        console.error('Erro na API:', err.message);
        return res.status(400).json({ error: err.message });
    }
    next();
});

app.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
});
