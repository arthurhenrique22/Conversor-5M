const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');
const http = require('http');

async function runTest() {
    console.log('[E2E TEST] Iniciando teste E2E...');
    const filePath = 'C:\\Users\\gabri\\OneDrive\\Área de Trabalho\\Conversor 5M\\test.mov';
    
    if (!fs.existsSync(filePath)) {
        console.error('Arquivo test.mov não encontrado!');
        process.exit(1);
    }
    
    const form = new FormData();
    form.append('video', fs.createReadStream(filePath));
    
    const batchId = 'e2e-single-batch';
    const testSessionId = 'e2e-session-123';

    try {
        console.log('[E2E TEST] Fazendo upload...');
        const res = await axios.post(`http://localhost:3005/api/upload/${batchId}`, form, {
            headers: {
                ...form.getHeaders(),
                'x-session-id': testSessionId
            }
        });
        
        console.log('[E2E TEST] Upload sucesso:', res.data);
        const jobId = res.data.jobId;
        
        console.log('[E2E TEST] Conectando ao SSE...');
        http.get(`http://localhost:3005/api/progress/batch/${batchId}?sessionId=${testSessionId}`, (sseRes) => {
            let buffer = '';
            sseRes.on('data', (chunk) => {
                buffer += chunk.toString();
                let lines = buffer.split('\n');
                buffer = lines.pop();
                
                for (let line of lines) {
                    if (line.startsWith('data: ')) {
                        const batchData = JSON.parse(line.slice(6));
                        const data = batchData.find(j => j.jobId === jobId) || batchData[0];
                        if (!data) continue;
                        console.log(`[SSE] ${data.status} - Progresso: ${data.progress}%`);
                        
                        if (data.status === 'Concluído') {
                            console.log('[E2E TEST] Download...');
                            axios.get(`http://localhost:3005/api/download/${batchId}/${jobId}?sessionId=${testSessionId}`, { responseType: 'stream' })
                                .then(dRes => {
                                    console.log('[E2E TEST] Download OK! Status:', dRes.status);
                                    process.exit(0);
                                }).catch(e => {
                                    console.error('[E2E TEST] Download Falhou:', e.message);
                                    process.exit(1);
                                });
                        } else if (data.status === 'Erro') {
                            console.error('[E2E TEST] Erro SSE:', data.error);
                            process.exit(1);
                        }
                    }
                }
            });
        });
        
    } catch (err) {
        console.error('[E2E TEST] Falha no teste:');
        if (err.response) {
            console.error(err.response.data);
        } else {
            console.error(err.message);
        }
        process.exit(1);
    }
}

runTest();
