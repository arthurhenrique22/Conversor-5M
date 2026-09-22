const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const http = require('http');

async function runBatchTest() {
    console.log('[E2E BATCH TEST] Iniciando...');
    const originalFile = 'C:\\Users\\gabri\\OneDrive\\Área de Trabalho\\Conversor 5M\\test.mov';
    
    if (!fs.existsSync(originalFile)) {
        console.error('Arquivo test.mov original não encontrado!');
        process.exit(1);
    }

    const tmpBatchDir = path.join(__dirname, 'batch_test');
    if (!fs.existsSync(tmpBatchDir)) fs.mkdirSync(tmpBatchDir);

    const numFiles = 5;
    const filePaths = [];
    for (let i = 1; i <= numFiles; i++) {
        const fp = path.join(tmpBatchDir, `video_test_${i}.mov`);
        fs.copyFileSync(originalFile, fp);
        filePaths.push(fp);
    }
    
    const batchId = 'test-batch-999';
    console.log(`[E2E BATCH TEST] Gerados ${numFiles} arquivos. Enviando para o lote ${batchId}...`);
    
    const jobIds = [];
    
    // Simular upload de todos (não precisa limitar no script pq axios cuida disso)
    for (let fp of filePaths) {
        const form = new FormData();
        form.append('video', fs.createReadStream(fp));
        
        const res = await axios.post(`http://localhost:3005/api/upload/${batchId}`, form, { headers: form.getHeaders() });
        jobIds.push(res.data.jobId);
        console.log(`Upload concluído: ${res.data.originalName} -> ${res.data.jobId}`);
    }

    console.log('[E2E BATCH TEST] Conectando ao SSE do Lote...');
    http.get(`http://localhost:3005/api/progress/batch/${batchId}`, (sseRes) => {
        let buffer = '';
        sseRes.on('data', (chunk) => {
            buffer += chunk.toString();
            let lines = buffer.split('\n');
            buffer = lines.pop();
            
            for (let line of lines) {
                if (line.startsWith('data: ')) {
                    const data = JSON.parse(line.slice(6));
                    
                    const completed = data.filter(j => j.status === 'Concluído').length;
                    console.log(`[SSE UPDATE] ${completed}/${numFiles} concluídos.`);
                    
                    // Exibir status individual simplificado
                    data.forEach(j => {
                        if (j.status === 'Convertendo') {
                            console.log(` -> ${j.jobId} : ${j.status} ${j.progress}%`);
                        }
                    });

                    if (completed === numFiles) {
                        console.log('[E2E BATCH TEST] Todos convertidos! Testando ZIP...');
                        axios.get(`http://localhost:3005/api/download/batch/${batchId}/zip`, { responseType: 'stream' })
                            .then(zRes => {
                                console.log('[E2E BATCH TEST] ZIP OK! Status:', zRes.status);
                                // Limpar temp
                                for (let fp of filePaths) fs.unlinkSync(fp);
                                fs.rmdirSync(tmpBatchDir);
                                process.exit(0);
                            })
                            .catch(e => {
                                console.error('[E2E BATCH TEST] ZIP Falhou:', e.message);
                                process.exit(1);
                            });
                    }
                }
            }
        });
    });
}

runBatchTest();
