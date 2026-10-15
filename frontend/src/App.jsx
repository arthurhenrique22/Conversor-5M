import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { 
  Upload, Film, FileVideo, Download, X, Play, Shield, Smartphone, Layers, Plus, Trash, RotateCcw
} from 'lucide-react';
import AdSenseBlock from './components/AdSenseBlock';

const getApiUrl = () => {
  if (import.meta.env.VITE_API_URL) {
    return import.meta.env.VITE_API_URL.replace(/\/$/, '');
  }
  if (import.meta.env.PROD) {
    return 'https://conversor-5m-production.up.railway.app';
  }
  return 'http://localhost:3005';
};

const API_URL = getApiUrl();
const MAX_CONCURRENT_UPLOADS = 3;

const normalizeProgress = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || isNaN(num)) return 0;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
};

const formatErrorMessage = (error) => {
  if (!error) return 'Ocorreu um erro inesperado.';
  const msg = typeof error === 'string' ? error : (error.message || '');
  
  if (msg.includes('Failed to fetch') || msg.includes('NetworkError') || msg.includes('net::ERR') || msg.includes('Failed to load')) {
    return 'Não foi possível conectar ao servidor. Verifique sua conexão ou tente novamente.';
  }
  if (msg.includes('Lote pertence a outra sessão') || msg.includes('403') || msg.includes('Acesso negado')) {
    return 'Sessão expirada ou não autorizada. Recarregue a página.';
  }
  if (msg.includes('Limite de armazenamento') || msg.includes('503')) {
    return 'Servidor temporariamente ocupado. Tente novamente em instantes.';
  }
  if (msg.includes('Limite de') && msg.includes('simultâneos')) {
    return msg;
  }
  if (msg.includes('Formato não suportado') || msg.includes('arquivo MOV')) {
    return 'Formato inválido. Use um arquivo de vídeo MOV.';
  }
  if (msg.includes('Arquivo muito grande') || msg.includes('file too large')) {
    return 'O arquivo excede o limite máximo permitido de 500 MB.';
  }
  if (msg.includes('Erro no servidor') || msg.includes('Falha no upload')) {
    return 'Não foi possível enviar o vídeo para o servidor. Tente novamente.';
  }
  if (msg.includes('conversão') || msg.includes('processamento') || msg.includes('FFmpeg')) {
    return 'Ocorreu um problema durante a conversão deste arquivo.';
  }
  return msg;
};

const getStatusText = (status, error) => {
  switch (status) {
    case 'Pronto': return 'Pronto para iniciar';
    case 'Pendente': return 'Aguardando envio';
    case 'Enviando': return 'Enviando para o servidor...';
    case 'Aguardando': return 'Aguardando conversão';
    case 'Analisando vídeo': return 'Analisando vídeo...';
    case 'Convertendo': return 'Convertendo para MP4...';
    case 'Concluído': return 'MP4 pronto';
    case 'Erro': return formatErrorMessage(error);
    case 'Cancelado': return 'Cancelado';
    case 'Formato não suportado': return 'Formato inválido (use .mov)';
    default: return status;
  }
};

function App() {
  const [batchId, setBatchId] = useState(null);
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  
  const batchIdRef = useRef(null);
  const fileInputRef = useRef(null);
  const addMoreInputRef = useRef(null);
  const sseRef = useRef(null);

  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
    };
  }, []);

  const connectSSE = useCallback((currentBatchId) => {
    if (!currentBatchId) return;
    if (sseRef.current) return;
    
    console.log('[SSE] Conectando ao lote:', currentBatchId);
    const eventSource = new EventSource(
      `${API_URL}/api/progress/batch/${currentBatchId}`, 
      { withCredentials: true }
    );
    
    eventSource.onmessage = (event) => {
      try {
        const batchState = JSON.parse(event.data);
        if (!Array.isArray(batchState)) return;

        setFiles(prev => prev.map(f => {
          const bState = batchState.find(b => (f.jobId && b.jobId === f.jobId) || b.originalName === f.name);
          if (bState) {
            if (f.status === 'Enviando' || f.status === 'Pendente') return f;
            return {
              ...f,
              jobId: bState.jobId || f.jobId,
              status: bState.status,
              progress: normalizeProgress(bState.progress),
              error: bState.error ? formatErrorMessage(bState.error) : f.error
            };
          }
          return f;
        }));
      } catch (err) {
        console.error('Erro ao processar SSE:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn('[SSE] EventSource aviso ou reconexão:', err);
      if (eventSource.readyState === EventSource.CLOSED) {
        sseRef.current = null;
      }
    };
    
    sseRef.current = eventSource;
  }, []);

  useEffect(() => {
    if (!isConverting) return;

    const uploadingFiles = files.filter(f => f.status === 'Enviando');
    const availableSlots = MAX_CONCURRENT_UPLOADS - uploadingFiles.length;
    if (availableSlots <= 0) return;

    const pendingFiles = files.filter(f => f.status === 'Pendente').slice(0, availableSlots);
    if (pendingFiles.length === 0) return;

    let currentBatchId = batchIdRef.current;
    if (!currentBatchId) {
      currentBatchId = batchId || uuidv4();
      batchIdRef.current = currentBatchId;
    }
    connectSSE(currentBatchId);

    const pendingIds = new Set(pendingFiles.map(f => f.id));
    setFiles(prev => prev.map(f => pendingIds.has(f.id) ? { ...f, status: 'Enviando', progress: 0 } : f));

    pendingFiles.forEach(async (fileItem) => {
      const formData = new FormData();
      formData.append('video', fileItem.file);

      try {
        const response = await fetch(`${API_URL}/api/upload/${currentBatchId}`, {
          method: 'POST',
          body: formData,
          credentials: 'include'
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({ error: 'Falha no upload' }));
          throw new Error(errData.error || `Erro HTTP ${response.status}`);
        }

        const data = await response.json();
        setFiles(prev => prev.map(f => 
          f.id === fileItem.id ? { ...f, jobId: data.jobId, status: 'Aguardando', progress: 0 } : f
        ));
      } catch (error) {
        console.error(`[Upload] Falha ao enviar vídeo ${fileItem.name}:`, error);
        setFiles(prev => prev.map(f => 
          f.id === fileItem.id ? { ...f, status: 'Erro', error: formatErrorMessage(error) } : f
        ));
      }
    });
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
          jobId: null,
          error: null
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

    const currentBatch = batchIdRef.current || batchId;
    if (isConverting && currentBatch && file.jobId && (file.status === 'Aguardando' || file.status === 'Convertendo' || file.status === 'Analisando vídeo')) {
      try {
        await fetch(`${API_URL}/api/cancel/${currentBatch}/${file.jobId}`, { 
          method: 'POST',
          credentials: 'include'
        });
      } catch (e) {
        console.error('Erro ao cancelar', e);
      }
    }
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const retryFile = (id) => {
    let currentBatch = batchIdRef.current;
    if (!currentBatch) {
      currentBatch = batchId || uuidv4();
      batchIdRef.current = currentBatch;
      setBatchId(currentBatch);
    }
    connectSSE(currentBatch);
    setIsConverting(true);
    setFiles(prev => prev.map(f => f.id === id ? { ...f, status: 'Pendente', progress: 0, error: null } : f));
  };

  const clearSelection = () => {
    setFiles([]);
    setIsConverting(false);
    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    batchIdRef.current = null;
    setBatchId(null);
  };

  const startConversion = () => {
    const validFiles = files.filter(f => f.status === 'Pronto');
    if (validFiles.length === 0) return;

    let currentBatch = batchIdRef.current;
    if (!currentBatch) {
      currentBatch = uuidv4();
      batchIdRef.current = currentBatch;
      setBatchId(currentBatch);
    }
    connectSSE(currentBatch);
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

  const triggerDownload = (url) => {
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', '');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const downloadZip = () => {
    const currentBatch = batchIdRef.current || batchId;
    if (!currentBatch) return;
    triggerDownload(`${API_URL}/api/download/batch/${currentBatch}/zip`);
  };

  const downloadSingle = (jobId) => {
    const currentBatch = batchIdRef.current || batchId;
    if (!jobId || !currentBatch) return;
    triggerDownload(`${API_URL}/api/download/${currentBatch}/${jobId}`);
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
  const failedCount = validFiles.filter(f => f.status === 'Erro').length;
  
  let sumProgress = 0;
  validFiles.forEach(f => {
    if (f.status === 'Concluído') sumProgress += 100;
    else if (['Enviando', 'Convertendo', 'Analisando vídeo'].includes(f.status)) sumProgress += normalizeProgress(f.progress);
  });
  const globalProgress = validFilesCount === 0 ? 0 : normalizeProgress(sumProgress / validFilesCount);

  const isFinished = isConverting && validFilesCount > 0 && validFiles.every(f => ['Concluído', 'Erro', 'Cancelado', 'Formato não suportado'].includes(f.status));

  useEffect(() => {
    if (isFinished && sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
  }, [isFinished]);

  const addMoreAfterFinish = () => {
    setIsConverting(false);
    addMoreInputRef.current.click();
  };

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
        <button className="btn-header" onClick={() => document.getElementById('workspace')?.scrollIntoView({behavior:'smooth'})}>
          Converter agora
        </button>
      </header>

      <section className="hero">
        <h1>Conversor de <span className="highlight">MOV para MP4</span></h1>
        <p>Converta seus vídeos MOV para MP4 de forma rápida, simples e gratuita. Envie dezenas de vídeos de uma só vez e baixe tudo quando terminar.</p>
        <p style={{fontSize: '0.9rem', marginTop: '1rem', color: 'var(--text-muted)'}}>OS 5 MAIORES HOMENS INTELIGENTES DA TERRA</p>
      </section>

      {/* Bloco de anúncio centralizado antes da área de conversão */}
      <AdSenseBlock />

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
               onClick={() => !isConverting && fileInputRef.current?.click()}>
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
                  <button className="btn-queue" onClick={() => addMoreInputRef.current?.click()}>
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
              {isConverting && !isFinished && (
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
              {isConverting && isFinished && (
                <>
                  <button className="btn-queue" onClick={clearCompleted}>Limpar concluídos</button>
                  <button className="btn-queue primary" onClick={addMoreAfterFinish}>
                    <Plus size={16} style={{marginRight: '6px'}}/> + Converter novos vídeos
                  </button>
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
                {failedCount > 0 && <div className="gp-stat"><div className="dot error"></div>{failedCount} com falha</div>}
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
                      <div style={{ display: 'flex', gap: '6px' }}>
                        {f.status === 'Erro' && (
                          <button className="btn-icon-pro" onClick={() => retryFile(f.id)} title="Tentar novamente">
                            <RotateCcw size={18} />
                          </button>
                        )}
                        <button className="btn-icon-pro" onClick={() => removeFile(f.id)} title="Remover">
                          <X size={18} />
                        </button>
                      </div>
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
