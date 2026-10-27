require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const { upload } = require('./src/middlewares/upload');
const { startConversion, cancelConversion, getBatchProgress, getBatchStatus, downloadFile, downloadZip } = require('./src/services/videoService');
const { startCleanupCron } = require('./src/utils/cleanup');

const app = express();
const PORT = process.env.PORT || 3000;

// Configurar trust proxy para proxies reversos (Railway, Cloudflare, Netlify)
app.set('trust proxy', 1);

// Lista explícita de origens permitidas
const DEFAULT_ALLOWED_ORIGINS = [
    'https://conversordos5m.netlify.app',
    'http://localhost:5173',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://127.0.0.1:3000'
];

const getOriginList = () => {
    const envOrigins = [
        process.env.FRONTEND_URL,
        process.env.ALLOWED_ORIGINS
    ].filter(Boolean).flatMap(val => val.split(','));

    const all = [...DEFAULT_ALLOWED_ORIGINS, ...envOrigins]
        .map(o => o.trim().replace(/\/+$/, ''))
        .filter(Boolean);

    return Array.from(new Set(all));
};

const allowedOrigins = getOriginList();

const isOriginAllowed = (origin) => {
    if (!origin) return true; // Requisições locais/sem origin (curl, server-to-server)
    const normalized = origin.trim().replace(/\/+$/, '');
    return allowedOrigins.includes(normalized);
};

// Logging de requisições gerais
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] [REQUEST] ${req.method} ${req.url} | Origin: ${req.headers.origin || 'N/A'}`);
    next();
});

// Configurar CORS
const corsOptions = {
    origin: (origin, callback) => {
        if (isOriginAllowed(origin)) {
            callback(null, true);
        } else {
            console.warn(`[${new Date().toISOString()}] [CORS] Origem bloqueada: ${origin}`);
            callback(new Error(`Origem não permitida por CORS: ${origin}`));
        }
    },
    methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Requested-With',
        'Accept',
        'Origin',
        'Range',
        'Cache-Control'
    ],
    exposedHeaders: [
        'Content-Disposition',
        'Content-Length',
        'Content-Range'
    ],
    credentials: true,
    maxAge: 86400
};

// Aplicar middleware CORS antes de qualquer rota ou parser
app.use(cors(corsOptions));

// Garantir resposta rápida com 204 para requisições preflight OPTIONS
app.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
        return res.sendStatus(204);
    }
    next();
});

app.use(express.json());

// Garantir que a pasta tmp existe
const tmpDir = path.join(__dirname, 'tmp');
if (!fs.existsSync(tmpDir)) {
    fs.mkdirSync(tmpDir, { recursive: true });
}

// Iniciar cron job de limpeza
startCleanupCron();

// Middleware para rastrear o progresso do upload da rede SEM consumir o corpo da requisição
const trackUploadProgress = (req, res, next) => {
    const contentLength = parseInt(req.headers['content-length'] || '0', 10);
    const batchId = req.params.batchId || 'unknown';
    let receivedBytes = 0;
    let lastLoggedPercent = -1;
    let lastLogTime = Date.now();
    const startTime = Date.now();

    console.log(`[${new Date().toISOString()}] [UPLOAD INICIADO] Lote: ${batchId} | Content-Length: ${contentLength} bytes (${(contentLength / (1024 * 1024)).toFixed(2)} MB)`);

    req.on('data', (chunk) => {
        receivedBytes += chunk.length;
        const now = Date.now();
        
        if (contentLength > 0) {
            const currentPercent = Math.floor((receivedBytes / contentLength) * 100);
            if (currentPercent >= lastLoggedPercent + 10 || (now - lastLogTime > 5000 && currentPercent > lastLoggedPercent)) {
                lastLoggedPercent = currentPercent;
                lastLogTime = now;
                const elapsedSec = (now - startTime) / 1000;
                const speed = elapsedSec > 0 ? (receivedBytes / elapsedSec / (1024 * 1024)).toFixed(2) : '0';
                const memMb = (process.memoryUsage().rss / (1024 * 1024)).toFixed(1);
                console.log(`[${new Date().toISOString()}] [UPLOAD RECEBENDO] Lote: ${batchId} | ${currentPercent}% (${(receivedBytes / (1024 * 1024)).toFixed(1)} / ${(contentLength / (1024 * 1024)).toFixed(1)} MB) | Taxa: ${speed} MB/s | RAM: ${memMb} MB`);
            }
        }
    });

    req.on('end', () => {
        const totalDuration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`[${new Date().toISOString()}] [UPLOAD REDE CONCLUÍDO] Lote: ${batchId} | Total recebido: ${(receivedBytes / (1024 * 1024)).toFixed(2)} MB em ${totalDuration}s`);
    });

    req.on('aborted', () => {
        console.warn(`[${new Date().toISOString()}] [UPLOAD INTERROMPIDO/ABORTADO] Lote: ${batchId} após ${(receivedBytes / (1024 * 1024)).toFixed(2)} MB`);
    });

    req.on('error', (err) => {
        console.error(`[${new Date().toISOString()}] [UPLOAD ERRO DE REDE] Lote: ${batchId}:`, err.message);
    });

    next();
};

// Rotas da API

// Rota raiz para status e verificação de saúde básica
app.get('/', (req, res) => {
    res.status(200).json({
        status: 'online',
        service: 'Conversor dos 5M API',
        version: '1.0.0',
        timestamp: new Date().toISOString()
    });
});

app.get('/health', (req, res) => {
    res.status(200).json({
        status: 'OK',
        uptime: process.uptime(),
        memoryRSS: `${(process.memoryUsage().rss / (1024 * 1024)).toFixed(1)} MB`,
        timestamp: new Date().toISOString()
    });
});

// Upload atrelado a um lote (com rastreamento de progresso de stream antes do Multer)
app.post('/api/upload/:batchId', trackUploadProgress, upload.single('video'), async (req, res) => {
    const batchId = req.params.batchId;

    if (!req.file) {
        console.warn(`[${new Date().toISOString()}] [UPLOAD REJEITADO] Lote: ${batchId} | Nenhum arquivo válido recebido no campo "video".`);
        return res.status(400).json({ error: 'Nenhum arquivo enviado ou formato inválido. Use um arquivo MOV.' });
    }

    const actualJobId = path.parse(req.file.filename).name; 
    const fileMb = (req.file.size / (1024 * 1024)).toFixed(2);
    
    console.log(`[${new Date().toISOString()}] [PARSER MULTIPART FINALIZADO] Lote: ${batchId} | Job: ${actualJobId} | Arquivo: "${req.file.originalname}" (${fileMb} MB) gravado em: ${req.file.path}`);

    try {
        await startConversion(batchId, req.file.path, req.file.originalname, actualJobId);
        
        console.log(`[${new Date().toISOString()}] [UPLOAD RESPOSTA ENVIADA] Lote: ${batchId} | Job: ${actualJobId} enfileirado com sucesso.`);
        
        res.status(200).json({ 
            jobId: actualJobId, 
            batchId: batchId, 
            originalName: req.file.originalname, 
            size: req.file.size,
            message: 'Arquivo recebido com sucesso e adicionado à fila de conversão' 
        });
    } catch (error) {
        console.error(`[${new Date().toISOString()}] [UPLOAD ERRO INICIALIZAÇÃO] Lote: ${batchId}:`, error);
        res.status(500).json({ error: 'Falha ao processar o vídeo.' });
    }
});

// Cancelamento de job no lote
app.post('/api/cancel/:batchId/:jobId', (req, res) => {
    const { batchId, jobId } = req.params;
    const cancelled = cancelConversion(batchId, jobId);
    if (cancelled) {
        res.json({ success: true, message: 'Processo cancelado' });
    } else {
        res.status(404).json({ error: 'Processo não encontrado ou não pôde ser cancelado' });
    }
});

// Consulta imediata de status do lote (sincronização REST ao voltar à aba)
app.get('/api/batch/:batchId/status', getBatchStatus);

// Progresso do lote via Server-Sent Events (SSE)
app.get('/api/progress/batch/:batchId', getBatchProgress);

// Download de arquivo individual
app.get('/api/download/:id', downloadFile);

// Download de lote completo em ZIP
app.get('/api/download/batch/:batchId/zip', downloadZip);

// Error handling middleware (com suporte a CORS garantido nas respostas de erro)
app.use((err, req, res, next) => {
    const origin = req.headers.origin;
    if (origin && isOriginAllowed(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        res.setHeader('Vary', 'Origin');
    }

    console.error(`[${new Date().toISOString()}] [ERRO API]:`, err.message);

    if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ 
            error: 'Arquivo muito grande. O limite máximo permitido é de 500MB.' 
        });
    }

    const statusCode = err.status || err.statusCode || (err.message && err.message.includes('CORS') ? 403 : 400);
    return res.status(statusCode).json({ 
        error: err.message || 'Erro ao processar requisição.' 
    });
});

const server = app.listen(PORT, () => {
    console.log(`[${new Date().toISOString()}] [Servidor] Rodando na porta ${PORT}`);
    console.log(`[${new Date().toISOString()}] [CORS] Origens permitidas:`, allowedOrigins);
});

// Configurar timeouts adequados para uploads grandes (10 minutos)
server.timeout = 10 * 60 * 1000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

module.exports = { app, server };
