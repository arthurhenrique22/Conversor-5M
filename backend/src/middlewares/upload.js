const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const tmpDir = path.join(__dirname, '../../tmp');

// Garantir diretório de armazenamento temporário
const ensureTmpDir = () => {
    if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
        console.log(`[${new Date().toISOString()}] [ARMAZENAMENTO] Diretório temporário criado em: ${tmpDir}`);
    }
};
ensureTmpDir();

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        try {
            ensureTmpDir();
            cb(null, tmpDir);
        } catch (err) {
            console.error(`[${new Date().toISOString()}] [ARMAZENAMENTO ERRO] Falha ao preparar diretório:`, err.message);
            cb(err);
        }
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomUUID();
        const ext = path.extname(file.originalname).toLowerCase() || '.mov';
        const finalName = `${uniqueSuffix}${ext}`;
        console.log(`[${new Date().toISOString()}] [MULTER GRAVANDO] Lote: ${req.params.batchId || 'N/A'} | Arquivo original: "${file.originalname}" -> Destino temporário: ${finalName}`);
        cb(null, finalName);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    console.log(`[${new Date().toISOString()}] [UPLOAD VALIDAÇÃO] Lote: ${req.params.batchId || 'N/A'} | Arquivo: "${file.originalname}" | Ext: "${ext}" | Mime: "${file.mimetype}"`);
    
    if (ext !== '.mov') {
        console.warn(`[${new Date().toISOString()}] [UPLOAD REJEITADO] Extensão inválida: "${ext}". Somente arquivos MOV são aceitos.`);
        return cb(new Error('Formato não suportado. Selecione um arquivo MOV.'));
    }
    cb(null, true);
};

const MAX_FILE_SIZE = process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE, 10) : 1024 * 1024 * 500; // 500MB default

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: MAX_FILE_SIZE
    }
});

module.exports = { upload, tmpDir, MAX_FILE_SIZE };
