const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');

const { upload } = require('./src/middlewares/upload');
const { checkStorageLimit } = require('./src/utils/systemLimits');
const { startConversion, cancelConversion, getBatchProgress, downloadFile, downloadZip } = require('./src/services/videoService');
const { startCleanupCron } = require('./src/utils/cleanup');

const app = express();
const PORT = process.env.PORT || 3005;

app.use((req, res, next) => {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
    next();
});

// Configuração robusta de CORS
const allowedOrigins = (process.env.FRONTEND_URL || '')
    .split(',')
    .map(url => url.trim().replace(/\/$/, ''))
    .filter(Boolean);

const isOriginAllowed = (origin) => {
    if (!origin) return true; // Permite requisições sem origin (curl, mobile, testes internos)
    const cleanOrigin = origin.replace(/\/$/, '');

    // Permitir explicitamente URLs configuradas no ambiente
    if (allowedOrigins.includes(cleanOrigin)) return true;

    // Permitir qualquer localhost e 127.0.0.1 em qualquer porta
    if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(cleanOrigin)) {
        return true;
    }

    // Permitir qualquer subdomínio do Netlify (*.netlify.app)
    if (/^https:\/\/[a-zA-Z0-9_.-]+\.netlify\.app$/.test(cleanOrigin)) {
        return true;
    }

    // Permitir domínios relacionados ao projeto Conversor 5M
    if (/^https?:\/\/(www\.)?conversor.*5m.*\.[a-z.]+$/i.test(cleanOrigin)) {
        return true;
    }

    return false;
};

const corsOptions = {
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
            callback(null, true);
        } else {
            console.warn(`[CORS Bloqueado] Origem: ${origin}`);
            callback(new Error('Origem não permitida por CORS'));
        }
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Accept', 'Authorization', 'Range', 'Cache-Control', 'X-Requested-With', 'X-Session-Id'],
    exposedHeaders: ['Content-Disposition', 'Content-Length', 'X-Session-Id'],
    credentials: true,
    maxAge: 86400,
    optionsSuccessStatus: 200
};

app.use(cors(corsOptions));
app.use(express.json());
app.use(cookieParser());

// Configuração de sessão unificada (Header X-Session-Id, Query param ?sessionId ou Cookie)
app.use((req, res, next) => {
    let sessionId = req.headers['x-session-id'] || req.query.sessionId || req.cookies.sessionId;
    if (!sessionId) {
        sessionId = crypto.randomUUID();
    }
    
    // Em produção com HTTPS deve usar secure: true e sameSite: 'none' se cross-origin, senão 'lax'
    const isProd = process.env.NODE_ENV === 'production';
    res.cookie('sessionId', sessionId, { 
        httpOnly: true, 
        secure: isProd, 
        sameSite: isProd ? 'none' : 'lax', 
        maxAge: 24 * 60 * 60 * 1000 // 24h
    });
    
    // Expõe o sessionId nos headers da resposta
    res.setHeader('X-Session-Id', sessionId);
    req.sessionId = sessionId;
    next();
});

// Garantir que a pasta tmp existe
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Iniciar cron job de limpeza
startCleanupCron();

// Rotas da API

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// Upload atrelado a um lote
app.post('/api/upload/:batchId', checkStorageLimit, upload.single('video'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'Nenhum arquivo enviado ou formato inválido. Use um arquivo MOV.' });
    }

    const batchId = req.params.batchId;
    const sessionId = req.sessionId;
    const actualJobId = path.parse(req.file.filename).name; 
    
    try {
        await startConversion(batchId, sessionId, req.file.path, req.file.originalname, actualJobId);
        res.json({ jobId: actualJobId, batchId: batchId, originalName: req.file.originalname, message: 'Adicionado à fila' });
    } catch (error) {
        console.error('Erro ao iniciar conversão:', error);
        // Se der erro (ex: limite de tarefas globais)
        if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
        res.status(error.status || 500).json({ error: error.message || 'Falha ao processar o vídeo.' });
    }
});

app.post('/api/cancel/:batchId/:jobId', (req, res) => {
    const { batchId, jobId } = req.params;
    const sessionId = req.sessionId;
    const cancelled = cancelConversion(batchId, jobId, sessionId);
    if (cancelled) {
        res.json({ success: true, message: 'Processo cancelado' });
    } else {
        res.status(403).json({ error: 'Processo não encontrado ou não pôde ser cancelado' });
    }
});

app.get('/api/progress/batch/:batchId', getBatchProgress);

app.get('/api/download/:batchId/:jobId', downloadFile);

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
