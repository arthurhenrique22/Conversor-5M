const multer = require('multer');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const tmpDir = path.join(__dirname, '../../tmp');

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        if (!fs.existsSync(tmpDir)) {
            fs.mkdirSync(tmpDir, { recursive: true });
        }
        cb(null, tmpDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = crypto.randomUUID();
        // Preserva a extensão original e adiciona um UUID para evitar conflitos e dir traversal
        cb(null, `${uniqueSuffix}${path.extname(file.originalname).toLowerCase()}`);
    }
});

const fileFilter = (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ext !== '.mov') {
        return cb(new Error('Formato não suportado. Selecione um arquivo MOV.'));
    }
    cb(null, true);
};

const upload = multer({ 
    storage: storage,
    fileFilter: fileFilter,
    limits: {
        fileSize: process.env.MAX_FILE_SIZE ? parseInt(process.env.MAX_FILE_SIZE) : 1024 * 1024 * 500 // 500MB default
    }
});

module.exports = { upload };
