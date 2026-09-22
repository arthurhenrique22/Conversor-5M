import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { 
  Upload, Film, FileVideo, Download, X, Play, Trash2, CheckCircle, AlertTriangle, Cpu, Shield, Smartphone, Layers, Plus, Trash, Loader2
} from 'lucide-react';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3005';
const MAX_CONCURRENT_UPLOADS = 3;

const normalizeProgress = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || isNaN(num)) return 0;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
};

const getStatusText = (status, error) => {
  switch (status) {
    case 'Pronto': return 'Pronto para iniciar';
    case 'Pendente': return 'Aguardando upload';
    case 'Enviando': return 'Enviando para o servidor';
    case 'Aguardando': return 'Aguardando conversão';
    case 'Analisando vídeo': return 'Analisando vídeo...';
    case 'Convertendo': return 'Convertendo para MP4...';
    case 'Concluído': return 'MP4 pronto';
    case 'Erro': return error || 'Erro no processamento';
    case 'Cancelado': return 'Cancelado';
    case 'Formato não suportado': return 'Formato inválido';
    default: return status;
  }
};

function App() {
  const [batchId, setBatchId] = useState(null);
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  
  const fileInputRef = useRef(null);
  const addMoreInputRef = useRef(null);
  const sseRef = useRef(null);

  useEffect(() => {
    return () => {
      if (sseRef.current) sseRef.current.close();
    };
  }, []);

  const connectSSE = useCallback((currentBatchId) => {
    if (sseRef.current) return;
    
    console.log('[SSE] Conectando ao lote:', currentBatchId);
    const eventSource = new EventSource(`${API_URL}/api/progress/batch/${currentBatchId}`);
    
    eventSource.onmessage = (event) => {
      try {
        const batchState = JSON.parse(event.data);
        setFiles(prev => prev.map(f => {
          const bState = batchState.find(b => b.originalName === f.name);
          if (bState) {
            if (f.status === 'Enviando' || f.status === 'Pendente') return f;
            return {
              ...f,
              jobId: bState.jobId,
              status: bState.status,
              progress: normalizeProgress(bState.progress),
              error: bState.error
            };
          }
          return f;
        }));
      } catch (err) {
        console.error('Erro ao processar SSE:', err);
      }
    };
    
    sseRef.current = eventSource;
  }, []);

  useEffect(() => {
    if (!isConverting) return;

    const uploadNext = async () => {
      const uploadingCount = files.filter(f => f.status === 'Enviando').length;
      if (uploadingCount >= MAX_CONCURRENT_UPLOADS) return;

      const nextFile = files.find(f => f.status === 'Pendente');
      if (!nextFile) return;

      setFiles(prev => prev.map(f => f.id === nextFile.id ? { ...f, status: 'Enviando', progress: 0 } : f));
      
      let currentBatchId = batchId;
      if (!currentBatchId) {
        currentBatchId = uuidv4();
        setBatchId(currentBatchId);
        connectSSE(currentBatchId);
      } else if (!sseRef.current) {
        connectSSE(currentBatchId);
      }

      const formData = new FormData();
      formData.append('video', nextFile.file);

      try {
        const response = await fetch(`${API_URL}/api/upload/${currentBatchId}`, {
          method: 'POST',
          body: formData
        });

        if (!response.ok) {
          const errData = await response.json().catch(()=>({error: 'Falha no upload'}));
          throw new Error(errData.error || 'Erro no servidor');
        }

        const data = await response.json();
        
        setFiles(prev => prev.map(f => 
          f.id === nextFile.id ? { ...f, jobId: data.jobId, status: 'Aguardando', progress: 0 } : f
        ));
      } catch (error) {
        setFiles(prev => prev.map(f => 
          f.id === nextFile.id ? { ...f, status: 'Erro', error: error.message } : f
        ));
      }
    };

    uploadNext();
  }, [files, batchId, connectSSE, isConverting]);

  const handleFilesAdded = (newFilesList) => {
    const newFiles = Array.from(newFilesList);
    
    setFiles(prev => {
      const added = [];
      newFiles.forEach(file => {
        const isDuplicate = prev.some(p => p.name === file.name && p.size === file.size && p.lastModified === file.lastModified) || 
                            added.some(a => a.name === file.name && a.size === file.size && a.lastModified === file.lastModified);
        
        if (isDuplicate) return;

        const isMov = file.name.toLowerCase().endsWith('.mov');
        
        added.push({
          id: uuidv4(),
          file,
          name: file.name,
          size: file.size,
          lastModified: file.lastModified,
          status: isMov ? 'Pronto' : 'Formato não suportado',
          progress: 0,
          jobId: null
        });
      });
      return [...prev, ...added];
    });
  };

  const onDragOver = (e) => {
    e.preventDefault();
    if (!isConverting) setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e) => {
    e.preventDefault();
    setIsDragging(false);
    if (!isConverting && e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      handleFilesAdded(e.dataTransfer.files);
    }
  };

  const removeFile = async (id) => {
    const file = files.find(f => f.id === id);
    if (!file) return;

    if (isConverting && file.jobId && (file.status === 'Aguardando' || file.status === 'Convertendo' || file.status === 'Analisando vídeo')) {
      try {
        await fetch(`${API_URL}/api/cancel/${batchId}/${file.jobId}`, { method: 'POST' });
      } catch (e) {
        console.error('Erro ao cancelar', e);
      }
    }
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const clearSelection = () => setFiles([]);

  const startConversion = () => {
    const validFiles = files.filter(f => f.status === 'Pronto');
    if (validFiles.length === 0) return;

    setIsConverting(true);
    setFiles(prev => prev.map(f => f.status === 'Pronto' ? { ...f, status: 'Pendente' } : f));
  };

  const cancelPending = () => {
    files.forEach(f => {
      if (f.status === 'Pendente' || f.status === 'Aguardando') removeFile(f.id);
    });
  };

  const clearCompleted = () => {
    setFiles(prev => prev.filter(f => f.status !== 'Concluído'));
  };

  const downloadZip = () => {
    if (!batchId) return;
    window.location.href = `${API_URL}/api/download/batch/${batchId}/zip`;
  };

  const downloadSingle = (jobId) => {
    if (!jobId) return;
    window.location.href = `${API_URL}/api/download/${jobId}`;
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 MB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const validFiles = files.filter(f => f.status !== 'Formato não suportado');
  const validFilesCount = validFiles.length;
  const totalSize = validFiles.reduce((acc, curr) => acc + curr.size, 0);

  const completed = validFiles.filter(f => f.status === 'Concluído').length;
  const inProgress = validFiles.filter(f => ['Enviando', 'Convertendo', 'Analisando vídeo'].includes(f.status)).length;
  const waiting = validFiles.filter(f => ['Pendente', 'Aguardando', 'Pronto'].includes(f.status)).length;
  
  let sumProgress = 0;
  validFiles.forEach(f => {
    if (f.status === 'Concluído') sumProgress += 100;
    else if (['Enviando', 'Convertendo', 'Analisando vídeo'].includes(f.status)) sumProgress += normalizeProgress(f.progress);
  });
  const globalProgress = validFilesCount === 0 ? 0 : normalizeProgress(sumProgress / validFilesCount);

  return (
    <>
      <header className="header">
        <div className="logo-container">
          <div className="logo">CONVERSOR DOS 5M</div>
          <span className="badge-free">Grátis</span>
        </div>
        <nav className="nav-links">
          <a href="#">Início</a>
          <a href="#">Como funciona</a>
          <a href="#">Vantagens</a>
          <a href="#">Perguntas</a>
        </nav>
        <button className="btn-header" onClick={() => document.getElementById('workspace').scrollIntoView({behavior:'smooth'})}>
          Converter agora
        </button>
      </header>

      <section className="hero">
        <div className="hero-badge">Rápido • Seguro • Conversão em massa</div>
        <h1>Conversor de <span className="highlight">MOV para MP4</span></h1>
        <p>Converta seus vídeos MOV para MP4 de forma rápida, simples e gratuita. Envie dezenas de vídeos de uma só vez e baixe tudo quando terminar.</p>
        <p style={{fontSize: '0.9rem', marginTop: '1rem', color: 'var(--text-muted)'}}>OS 5 MAIORES HOMENS INTELIGENTES DA TERRA</p>
      </section>

      <section className="workspace" id="workspace">
        <div className="lateral-card left">
          <Film className="icon" />
          <span>MOV</span>
        </div>

        <div 
          className={`dropzone-container ${isDragging ? 'active' : ''}`}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
        >
          <div className={`dropzone ${isDragging ? 'active' : ''} ${isConverting ? 'disabled' : ''}`} 
               onClick={() => !isConverting && fileInputRef.current.click()}>
            <div className="upload-icon">
              <Upload />
            </div>
            <h3>{isConverting ? 'Conversão em andamento' : 'Arraste seus vídeos MOV aqui'}</h3>
            <p>{isConverting ? 'Acompanhe o progresso abaixo' : 'ou clique para selecionar os arquivos'}</p>
            {!isConverting && <button className="btn-select">Selecionar vídeos</button>}
            <div className="supported-formats">
              Formato suportado: MOV | Selecione vários arquivos de uma só vez
            </div>
          </div>
          <input 
            type="file" 
            ref={fileInputRef} 
            onChange={(e) => handleFilesAdded(e.target.files)} 
            accept=".mov,video/quicktime" 
            multiple 
            style={{display: 'none'}} 
          />
          <input 
            type="file" 
            ref={addMoreInputRef} 
            onChange={(e) => handleFilesAdded(e.target.files)} 
            accept=".mov,video/quicktime" 
            multiple 
            style={{display: 'none'}} 
          />
        </div>

        <div className="lateral-card right">
          <FileVideo className="icon" />
          <span>MP4</span>
        </div>
      </section>

      {files.length > 0 && (
        <section className="queue-container">
          <div className="queue-header-pro">
            <div className="queue-info">
              <h2>Fila de Conversão</h2>
              <span className="queue-stats-badge">{validFilesCount} vídeos • {formatSize(totalSize)}</span>
            </div>
            <div className="queue-actions">
              {!isConverting && (
                <>
                  <button className="btn-queue" onClick={() => addMoreInputRef.current.click()}>
                    <Plus size={16} /> Adicionar
                  </button>
                  <button className="btn-queue" onClick={clearSelection}>
                    <Trash size={16} /> Limpar
                  </button>
                  <button className="btn-queue primary" onClick={startConversion}>
                    CONVERTER TUDO
                  </button>
                </>
              )}
              {isConverting && (
                <>
                  <button className="btn-queue" onClick={cancelPending}>Cancelar pendentes</button>
                  <button className="btn-queue" onClick={clearCompleted}>Limpar concluídos</button>
                  {completed > 0 && (
                    <button className="btn-queue primary" onClick={downloadZip}>
                      <Download size={16} style={{marginRight: '6px'}}/> BAIXAR TUDO EM ZIP
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {isConverting && (
            <div className="global-progress-pro">
              <div className="gp-header">
                <span className="gp-title">Progresso Geral</span>
                <span className="gp-percentage">{Math.round(globalProgress)}%</span>
              </div>
              <div className="gp-track">
                <div className="gp-fill" style={{width: `${globalProgress}%`}}></div>
              </div>
              <div className="gp-footer">
                <div className="gp-stat"><div className="dot waiting"></div>{waiting} aguardando</div>
                <div className="gp-stat"><div className="dot in-progress"></div>{inProgress} processando</div>
                <div className="gp-stat"><div className="dot completed"></div>{completed} concluídos</div>
              </div>
            </div>
          )}

          <div className="queue-list-pro">
            {files.map(f => {
              const isProcessing = ['Enviando', 'Convertendo', 'Analisando vídeo'].includes(f.status);
              const isDone = f.status === 'Concluído';
              const isError = f.status === 'Erro' || f.status === 'Formato não suportado';
              
              let progressValue = normalizeProgress(f.progress);
              if (isDone) progressValue = 100;
              
              return (
                <div className={`job-item-pro ${f.status}`} key={f.id}>
                  <div className="job-info-col">
                    <div className="job-name" title={f.name}>
                      <Film size={18} className="job-icon-file" />
                      {f.name}
                    </div>
                    <div className="job-size">{formatSize(f.size)}</div>
                  </div>
                  
                  <div className="job-status-col">
                    <div className="job-status-text">
                      <span className={`status-dot ${f.status}`}></span>
                      {getStatusText(f.status, f.error)}
                      {isProcessing && f.status === 'Convertendo' && (
                        <span className="job-percentage">{Math.round(progressValue)}%</span>
                      )}
                    </div>
                    
                    <div className="job-progress-wrapper">
                      <div className={`job-progress-bg ${isProcessing ? 'active' : ''} ${isDone ? 'done' : ''} ${isError ? 'error' : ''}`}>
                        <div 
                          className={`job-progress-fill ${f.status} ${isProcessing && f.status !== 'Convertendo' ? 'indeterminate' : ''}`} 
                          style={{width: `${progressValue}%`}}
                        ></div>
                      </div>
                    </div>
                  </div>

                  <div className="job-actions-col">
                    {isDone ? (
                      <button className="btn-download-pro" onClick={() => downloadSingle(f.jobId)}>
                        <Download size={16} /> BAIXAR MP4
                      </button>
                    ) : (
                      <button className="btn-icon-pro" onClick={() => removeFile(f.id)} title="Remover">
                        <X size={18} />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="features">
        <div className="feature-card">
          <div className="f-icon"><Play /></div>
          <h4>Conversão rápida</h4>
          <p>Processamento otimizado usando recursos eficientes do servidor.</p>
        </div>
        <div className="feature-card">
          <div className="f-icon"><Shield /></div>
          <h4>100% seguro</h4>
          <p>Seus arquivos são temporários e apagados automaticamente.</p>
        </div>
        <div className="feature-card">
          <div className="f-icon"><Smartphone /></div>
          <h4>Qualquer dispositivo</h4>
          <p>Funciona perfeitamente em PC, celular, tablet e mais.</p>
        </div>
        <div className="feature-card">
          <div className="f-icon"><Layers /></div>
          <h4>Conversão em massa</h4>
          <p>Envie dezenas de vídeos de uma vez sem travar o navegador.</p>
        </div>
      </section>

      <section className="steps-section">
        <div className="step">
          <div className="step-num">1</div>
          <div className="step-content">
            <h4>Envie seus arquivos</h4>
            <p>Arraste ou selecione seus vídeos MOV</p>
          </div>
        </div>
        <div className="step">
          <div className="step-num">2</div>
          <div className="step-content">
            <h4>Aguarde a conversão</h4>
            <p>Acompanhe cada vídeo em tempo real</p>
          </div>
        </div>
        <div className="step">
          <div className="step-num">3</div>
          <div className="step-content">
            <h4>Baixe seus MP4</h4>
            <p>Baixe individualmente ou todos juntos</p>
          </div>
        </div>
      </section>
    </>
  );
}

export default App;
