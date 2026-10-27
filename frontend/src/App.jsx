import React, { useState, useRef, useEffect, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { 
  Upload, Film, FileVideo, Download, X, Play, Shield, Smartphone, Layers, Plus, Trash, RotateCcw, RefreshCw
} from 'lucide-react';

const rawApiUrl = (import.meta.env.VITE_API_URL || 'http://localhost:3005').trim();
const API_URL = rawApiUrl.replace(/\/+$/, '');
const MAX_CONCURRENT_UPLOADS = 2; // Limite de 2 uploads simultâneos para proteger a largura de banda

// Hierarquia para evitar que respostas tardias regridam o status de um arquivo
const STATE_HIERARCHY = {
  'Pronto': 0,
  'Pendente': 1,
  'Enviando': 2,
  'Confirmando recebimento': 3,
  'Aguardando': 4,
  'Na fila': 4,
  'Analisando vídeo': 5,
  'Convertendo': 6,
  'Finalizando arquivo': 7,
  'Concluído': 8,
  'Erro': 9,
  'Cancelado': 9
};

const normalizeProgress = (value) => {
  if (value === undefined || value === null || value === '') return 0;
  const num = Number(value);
  if (!Number.isFinite(num) || isNaN(num)) return 0;
  if (num < 0) return 0;
  if (num > 100) return 100;
  return num;
};

const formatBytes = (bytes) => {
  if (!bytes || bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const formatSpeed = (bytesPerSec) => {
  if (!bytesPerSec || bytesPerSec <= 0) return '';
  if (bytesPerSec >= 1024 * 1024) {
    return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  }
  return (bytesPerSec / 1024).toFixed(0) + ' KB/s';
};

const formatETA = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds < 60) return `restante ${Math.ceil(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.ceil(seconds % 60);
  return `restante ${mins}m ${secs}s`;
};

const getStatusText = (f) => {
  switch (f.status) {
    case 'Pronto': 
      return 'Pronto para iniciar';
    case 'Pendente': 
      return 'Aguardando na fila de envio';
    case 'Enviando': {
      if (f.uploadLengthComputable === false) {
        return `Enviando: ${formatBytes(f.uploadLoaded || 0)} (total desconhecido)`;
      }
      const parts = [`Enviando: ${f.uploadProgress || 0}%`];
      if (f.uploadLoaded && f.uploadTotal) {
        parts.push(`(${formatBytes(f.uploadLoaded)} de ${formatBytes(f.uploadTotal)})`);
      }
      if (f.uploadSpeed) parts.push(`• ${f.uploadSpeed}`);
      if (f.uploadEta) parts.push(`• ${f.uploadEta}`);
      return parts.join(' ');
    }
    case 'Confirmando recebimento': 
      return 'Aguardando confirmação do servidor...';
    case 'Aguardando': 
    case 'Na fila':
      return 'Na fila de conversão';
    case 'Analisando vídeo': 
      return 'Analisando metadados do vídeo...';
    case 'Convertendo': {
      let text = 'Convertendo para MP4...';
      if (f.progress !== undefined && f.progress !== null) {
        text += ` ${Math.round(normalizeProgress(f.progress))}%`;
      }
      if (f.elapsedSeconds) {
        text += ` (${f.elapsedSeconds}s decorridos)`;
      }
      return text;
    }
    case 'Finalizando arquivo':
      return 'Finalizando arquivo...';
    case 'Concluído': 
      return 'MP4 pronto para download';
    case 'Erro': 
      return f.error || 'Erro no processamento';
    case 'Cancelado': 
      return 'Cancelado';
    case 'Formato não suportado': 
      return 'Formato inválido (use .MOV)';
    default: 
      return f.status;
  }
};

function App() {
  const [batchId, setBatchId] = useState(null);
  const batchIdRef = useRef(null);
  const [files, setFiles] = useState([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isConverting, setIsConverting] = useState(false);
  const [isSseConnected, setIsSseConnected] = useState(true);
  
  const fileInputRef = useRef(null);
  const addMoreInputRef = useRef(null);
  const sseRef = useRef(null);
  const activeXhrsRef = useRef({}); // { [fileId]: XMLHttpRequest }

  // Abortar XHRs e fechar SSE no unmount
  useEffect(() => {
    return () => {
      if (sseRef.current) {
        sseRef.current.close();
        sseRef.current = null;
      }
      Object.values(activeXhrsRef.current).forEach(xhr => {
        try { xhr.abort(); } catch (_) {}
      });
      activeXhrsRef.current = {};
    };
  }, []);

  // Sincronização REST instantânea do lote com o servidor
  const syncBatchStatus = useCallback(async (currentBatchId) => {
    if (!currentBatchId) return;

    try {
      const response = await fetch(`${API_URL}/api/batch/${currentBatchId}/status`, {
        credentials: 'include'
      });
      if (!response.ok) return;

      const data = await response.json();
      if (!data || !Array.isArray(data.jobs)) return;

      setFiles(prev => prev.map(f => {
        const remoteJob = data.jobs.find(b => b.jobId === f.jobId || b.originalName === f.name);
        if (!remoteJob) return f;

        const currentRank = STATE_HIERARCHY[f.status] ?? 0;
        const remoteRank = STATE_HIERARCHY[remoteJob.status] ?? 0;

        // Se o arquivo local ainda está enviando bytes ou confirmando, preservar o upload
        if ((f.status === 'Enviando' || f.status === 'Confirmando recebimento') && remoteJob.status === 'Aguardando') {
          return f;
        }

        // Não regredir o estado se o local já estiver em uma etapa igual ou superior
        if (currentRank > remoteRank && f.status !== 'Erro') {
          return f;
        }

        return {
          ...f,
          jobId: remoteJob.jobId || f.jobId,
          status: remoteJob.status,
          progress: normalizeProgress(remoteJob.progress),
          elapsedSeconds: remoteJob.elapsedSeconds,
          error: remoteJob.error
        };
      }));
    } catch (err) {
      console.warn('[Sync] Falha ao consultar status REST do lote:', err);
    }
  }, []);

  // Conexão SSE para acompanhamento em tempo real
  const connectSSE = useCallback((currentBatchId) => {
    if (!currentBatchId) return;

    if (sseRef.current) {
      if (sseRef.current._batchId === currentBatchId) return;
      sseRef.current.close();
      sseRef.current = null;
    }
    
    console.log('[SSE] Conectando ao lote:', currentBatchId);
    const eventSource = new EventSource(`${API_URL}/api/progress/batch/${currentBatchId}`, {
      withCredentials: true
    });
    eventSource._batchId = currentBatchId;
    
    eventSource.onopen = () => {
      setIsSseConnected(true);
    };

    eventSource.onmessage = (event) => {
      try {
        setIsSseConnected(true);
        const batchState = JSON.parse(event.data);
        if (!Array.isArray(batchState)) return;

        setFiles(prev => prev.map(f => {
          const bState = batchState.find(b => b.jobId === f.jobId || b.originalName === f.name);
          if (!bState) return f;

          const currentRank = STATE_HIERARCHY[f.status] ?? 0;
          const remoteRank = STATE_HIERARCHY[bState.status] ?? 0;

          // Se o arquivo ainda está fazendo upload local ou confirmando, preservar upload
          if ((f.status === 'Enviando' || f.status === 'Confirmando recebimento') && bState.status === 'Aguardando') {
            return f;
          }

          // Prevenir regressão de estado
          if (currentRank > remoteRank && f.status !== 'Erro') {
            return f;
          }

          return {
            ...f,
            jobId: bState.jobId || f.jobId,
            status: bState.status,
            progress: normalizeProgress(bState.progress),
            elapsedSeconds: bState.elapsedSeconds,
            error: bState.error
          };
        }));
      } catch (err) {
        console.error('[SSE] Erro ao processar dados de progresso:', err);
      }
    };

    eventSource.onerror = (err) => {
      console.warn('[SSE] Conexão de progresso instável. Reconectando...');
      setIsSseConnected(false);
    };
    
    sseRef.current = eventSource;
  }, []);

  // Sincronização ao voltar à aba ou à janela (Page Visibility API)
  useEffect(() => {
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible' && batchIdRef.current) {
        console.log('[Sync] Janela/aba ativa novamente. Sincronizando lote:', batchIdRef.current);
        syncBatchStatus(batchIdRef.current);
        // Garantir que o SSE está ativo se a conversão estiver em andamento
        if (isConverting && (!sseRef.current || sseRef.current.readyState === EventSource.CLOSED)) {
          connectSSE(batchIdRef.current);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityOrFocus);
    window.addEventListener('focus', handleVisibilityOrFocus);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      window.removeEventListener('focus', handleVisibilityOrFocus);
    };
  }, [syncBatchStatus, connectSSE, isConverting]);

  // Upload estritamente gerenciado por XMLHttpRequest para fornecer porcentagem real do envio
  const startUploadXhr = useCallback((targetFile, currentBatchId) => {
    const xhr = new XMLHttpRequest();
    const formData = new FormData();
    formData.append('video', targetFile.file);

    let startTime = Date.now();
    let samples = []; // [{ time, loaded }] para cálculo de velocidade suave e ETA estável
    let lastActivityTime = Date.now();

    // 1. REGISTRAR LISTENERS ANTES DE INICIAR A REQUISIÇÃO
    xhr.upload.onprogress = (e) => {
      lastActivityTime = Date.now();
      const now = Date.now();

      if (e.lengthComputable && e.total > 0) {
        samples.push({ time: now, loaded: e.loaded });
        if (samples.length > 8) samples.shift(); // Mantém janela móvel das últimas medições

        // Calcular velocidade e ETA somente quando houver medições suficientes (> 1s e > 2 amostras)
        let speedStr = '';
        let etaStr = '';
        const elapsedTotal = (now - startTime) / 1000;

        if (elapsedTotal >= 1.0 && samples.length >= 3) {
          const oldest = samples[0];
          const timeSpan = (now - oldest.time) / 1000;
          const bytesSpan = e.loaded - oldest.loaded;

          if (timeSpan > 0.3 && bytesSpan > 0) {
            const speedBytesPerSec = bytesSpan / timeSpan;
            speedStr = formatSpeed(speedBytesPerSec);
            const remainingBytes = e.total - e.loaded;
            const etaSec = remainingBytes / speedBytesPerSec;
            etaStr = formatETA(etaSec);
          }
        }

        const percent = Math.min(Math.floor((e.loaded / e.total) * 100), 99);

        setFiles(prev => prev.map(f => {
          if (f.id === targetFile.id) {
            return {
              ...f,
              status: 'Enviando',
              uploadLengthComputable: true,
              uploadProgress: percent,
              uploadLoaded: e.loaded,
              uploadTotal: e.total,
              uploadSpeed: speedStr,
              uploadEta: etaStr
            };
          }
          return f;
        }));
      } else {
        // Total desconhecido
        setFiles(prev => prev.map(f => {
          if (f.id === targetFile.id) {
            return {
              ...f,
              status: 'Enviando',
              uploadLengthComputable: false,
              uploadLoaded: e.loaded || 0,
              uploadSpeed: '',
              uploadEta: ''
            };
          }
          return f;
        }));
      }
    };

    // Quando todos os bytes saem do navegador pela rede
    xhr.upload.onload = () => {
      setFiles(prev => prev.map(f => {
        if (f.id === targetFile.id) {
          return {
            ...f,
            status: 'Confirmando recebimento',
            uploadProgress: 100,
            uploadSpeed: '',
            uploadEta: ''
          };
        }
        return f;
      }));
    };

    // Resposta final do servidor
    xhr.onload = () => {
      delete activeXhrsRef.current[targetFile.id];

      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText);
          setFiles(prev => prev.map(f => {
            if (f.id === targetFile.id) {
              const currentRank = STATE_HIERARCHY[f.status] ?? 0;
              // Não regredir se um evento SSE já moveu o arquivo para Convertendo ou Concluído
              if (currentRank >= STATE_HIERARCHY['Aguardando'] && f.status !== 'Erro') {
                return { ...f, jobId: data.jobId || f.jobId };
              }
              return {
                ...f,
                jobId: data.jobId,
                status: 'Aguardando',
                progress: 0,
                error: null
              };
            }
            return f;
          }));
        } catch (err) {
          setFiles(prev => prev.map(f => f.id === targetFile.id ? { ...f, status: 'Erro', error: 'Resposta inválida do servidor.' } : f));
        }
      } else {
        let errorMsg = `Erro no upload (${xhr.status})`;
        try {
          const data = JSON.parse(xhr.responseText);
          if (data && data.error) errorMsg = data.error;
        } catch (_) {
          if (xhr.status === 413) errorMsg = 'Arquivo muito grande (limite de 500MB excedido).';
          else if (xhr.status === 404) errorMsg = 'Serviço da API não encontrado (404). Verifique se o backend está ativo.';
          else if (xhr.status === 502 || xhr.status === 504) errorMsg = 'Servidor temporariamente indisponível ou timeout.';
        }
        setFiles(prev => prev.map(f => f.id === targetFile.id ? { ...f, status: 'Erro', error: errorMsg } : f));
      }
    };

    xhr.onerror = () => {
      delete activeXhrsRef.current[targetFile.id];
      setFiles(prev => prev.map(f => f.id === targetFile.id ? { 
        ...f, 
        status: 'Erro', 
        error: 'Falha de conexão com a API. Verifique sua rede e regras de CORS.' 
      } : f));
    };

    xhr.ontimeout = () => {
      delete activeXhrsRef.current[targetFile.id];
      setFiles(prev => prev.map(f => f.id === targetFile.id ? { ...f, status: 'Erro', error: 'Tempo limite esgotado (timeout).' } : f));
    };

    // Detecção de inatividade de rede (stall detection): alerta se passar 45s sem nenhum byte transmitido
    const stallInterval = setInterval(() => {
      const idleSeconds = (Date.now() - lastActivityTime) / 1000;
      if (idleSeconds > 45 && xhr.readyState < 4) {
        clearInterval(stallInterval);
        try { xhr.abort(); } catch (_) {}
        delete activeXhrsRef.current[targetFile.id];
        setFiles(prev => prev.map(f => f.id === targetFile.id ? { 
          ...f, 
          status: 'Erro', 
          error: 'Upload interrompido: sem resposta da rede por 45 segundos. Clique em tentar novamente.' 
        } : f));
      }
    }, 5000);

    xhr.onloadend = () => {
      clearInterval(stallInterval);
    };

    // 2. ABRIR E ENVIAR COM CREDENCIAIS E FORM DATA
    xhr.open('POST', `${API_URL}/api/upload/${currentBatchId}`);
    xhr.withCredentials = true; // Preserva credenciais de sessão e cookies
    xhr.send(formData);

    activeXhrsRef.current[targetFile.id] = xhr;
  }, []);

  // Efeito disparador de uploads concorrentes
  useEffect(() => {
    if (!isConverting) return;

    const currentUploading = files.filter(f => f.status === 'Enviando' || f.status === 'Confirmando recebimento').length;
    if (currentUploading >= MAX_CONCURRENT_UPLOADS) return;

    const nextFile = files.find(f => f.status === 'Pendente');
    if (!nextFile) return;

    let currentBatchId = batchIdRef.current;
    if (!currentBatchId) {
      currentBatchId = uuidv4();
      batchIdRef.current = currentBatchId;
      setBatchId(currentBatchId);
      connectSSE(currentBatchId);
    } else if (!sseRef.current) {
      connectSSE(currentBatchId);
    }

    // Marca imediatamente como Enviando
    setFiles(prev => prev.map(f => f.id === nextFile.id ? { 
      ...f, 
      status: 'Enviando', 
      uploadProgress: 0,
      uploadLoaded: 0,
      uploadTotal: nextFile.size,
      uploadLengthComputable: true,
      uploadSpeed: '',
      uploadEta: ''
    } : f));

    startUploadXhr(nextFile, currentBatchId);
  }, [files, connectSSE, isConverting, startUploadXhr]);

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
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadTotal: file.size,
          uploadLengthComputable: true,
          uploadSpeed: '',
          uploadEta: '',
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
    if (activeXhrsRef.current[id]) {
      try { activeXhrsRef.current[id].abort(); } catch (_) {}
      delete activeXhrsRef.current[id];
    }

    const file = files.find(f => f.id === id);
    if (!file) return;

    const currentBatchId = batchIdRef.current;
    if (isConverting && file.jobId && currentBatchId && (['Aguardando', 'Convertendo', 'Analisando vídeo', 'Finalizando arquivo'].includes(file.status))) {
      try {
        await fetch(`${API_URL}/api/cancel/${currentBatchId}/${file.jobId}`, { 
          method: 'POST',
          credentials: 'include'
        });
      } catch (e) {
        console.error('Erro ao cancelar:', e);
      }
    }
    setFiles(prev => prev.filter(f => f.id !== id));
  };

  const retryFile = (id) => {
    setFiles(prev => prev.map(f => {
      if (f.id === id && f.file) {
        const isMov = f.file.name.toLowerCase().endsWith('.mov');
        return {
          ...f,
          status: isConverting ? 'Pendente' : (isMov ? 'Pronto' : 'Formato não suportado'),
          error: null,
          progress: 0,
          uploadProgress: 0,
          uploadLoaded: 0,
          uploadSpeed: '',
          uploadEta: ''
        };
      }
      return f;
    }));
  };

  const clearSelection = () => {
    Object.values(activeXhrsRef.current).forEach(xhr => {
      try { xhr.abort(); } catch (_) {}
    });
    activeXhrsRef.current = {};

    if (sseRef.current) {
      sseRef.current.close();
      sseRef.current = null;
    }
    batchIdRef.current = null;
    setBatchId(null);
    setFiles([]);
    setIsConverting(false);
  };

  const startConversion = () => {
    const validFiles = files.filter(f => f.status === 'Pronto');
    if (validFiles.length === 0) return;

    if (!batchIdRef.current) {
      const newBatchId = uuidv4();
      batchIdRef.current = newBatchId;
      setBatchId(newBatchId);
      connectSSE(newBatchId);
    }

    setIsConverting(true);
    setFiles(prev => prev.map(f => f.status === 'Pronto' ? { ...f, status: 'Pendente' } : f));
  };

  const cancelPending = () => {
    files.forEach(f => {
      if (['Pendente', 'Enviando', 'Confirmando recebimento', 'Aguardando', 'Na fila'].includes(f.status)) {
        removeFile(f.id);
      }
    });
  };

  const clearCompleted = () => {
    setFiles(prev => prev.filter(f => f.status !== 'Concluído'));
  };

  const downloadZip = () => {
    const currentBatchId = batchIdRef.current;
    if (!currentBatchId) return;
    window.location.href = `${API_URL}/api/download/batch/${currentBatchId}/zip`;
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

  // Contadores específicos por etapa
  const uploadingCount = validFiles.filter(f => f.status === 'Enviando' || f.status === 'Confirmando recebimento').length;
  const waitingCount = validFiles.filter(f => ['Pendente', 'Aguardando', 'Na fila', 'Pronto'].includes(f.status)).length;
  const convertingCount = validFiles.filter(f => ['Analisando vídeo', 'Convertendo', 'Finalizando arquivo'].includes(f.status)).length;
  const completedCount = validFiles.filter(f => f.status === 'Concluído').length;
  const errorCount = validFiles.filter(f => f.status === 'Erro').length;

  // 1. Envio do lote: Porcentagem calculada a partir dos bytes enviados e totais (sem média simples)
  let totalBatchBytes = 0;
  let totalBatchLoaded = 0;

  validFiles.forEach(f => {
    const fSize = f.size || 0;
    totalBatchBytes += fSize;
    if (['Aguardando', 'Na fila', 'Analisando vídeo', 'Convertendo', 'Finalizando arquivo', 'Concluído'].includes(f.status)) {
      totalBatchLoaded += fSize;
    } else if (f.status === 'Enviando') {
      totalBatchLoaded += (f.uploadLoaded || 0);
    } else if (f.status === 'Confirmando recebimento') {
      totalBatchLoaded += fSize;
    }
  });

  const batchUploadProgress = totalBatchBytes > 0 ? Math.min(Math.round((totalBatchLoaded / totalBatchBytes) * 100), 100) : 0;
  const isAllUploaded = validFilesCount > 0 && uploadingCount === 0 && validFiles.every(f => !['Pendente', 'Enviando', 'Confirmando recebimento'].includes(f.status));

  // 2. Progresso das conversões concluídas (X de N arquivos)
  const conversionCompletedPercent = validFilesCount > 0 ? Math.round((completedCount / validFilesCount) * 100) : 0;

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
        <div className="hero-badge">Rápido • Seguro • Conversão em massa</div>
        <h1>Conversor de <span className="highlight">MOV para MP4</span></h1>
        <p>Converta seus vídeos MOV para MP4 de forma rápida, simples e gratuita. Envie dezenas de vídeos de uma só vez e baixe tudo quando terminar.</p>
        <p className="hero-subtitle">OS 5 MAIORES HOMENS INTELIGENTES DA TERRA</p>
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
               onClick={() => !isConverting && fileInputRef.current?.click()}>
            <div className="upload-icon">
              <Upload />
            </div>
            <h3>{isConverting ? 'Conversão em andamento' : 'Arraste seus vídeos MOV aqui'}</h3>
            <p>{isConverting ? 'Acompanhe o envio e o processamento abaixo' : 'ou clique para selecionar os arquivos'}</p>
            {!isConverting && <button className="btn-select">Selecionar vídeos</button>}
            <div className="supported-formats">
              Formato suportado: MOV | Selecione vários arquivos de uma só vez (até 500MB cada)
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
              {isConverting && (
                <>
                  <button className="btn-queue" onClick={cancelPending}>Cancelar pendentes</button>
                  <button className="btn-queue" onClick={clearCompleted}>Limpar concluídos</button>
                  <button className="btn-queue" onClick={() => addMoreInputRef.current?.click()}>
                    <Plus size={16} /> Adicionar mais
                  </button>
                  {completedCount > 0 && (
                    <button className="btn-queue primary" onClick={downloadZip}>
                      <Download size={16} style={{marginRight: '6px'}}/> BAIXAR TUDO EM ZIP
                    </button>
                  )}
                </>
              )}
            </div>
          </div>

          {/* PAINEL GERAL CLARO: SEPARAÇÃO DE ENVIO E CONVERSÃO (SEM 0% AMBÍGUO) */}
          {isConverting && (
            <div className="global-progress-pro">
              {/* Barra 1: Envio do Lote em Bytes Reais */}
              <div className="gp-section">
                <div className="gp-header">
                  <span className="gp-title">Envio do Lote</span>
                  <span className="gp-percentage">
                    {isAllUploaded ? '100% (Todos enviados)' : `${batchUploadProgress}% (${formatBytes(totalBatchLoaded)} de ${formatBytes(totalBatchBytes)})`}
                  </span>
                </div>
                <div className="gp-track">
                  <div className="gp-fill" style={{width: `${batchUploadProgress}%`}}></div>
                </div>
              </div>

              {/* Barra 2: Progresso das Conversões */}
              <div className="gp-section" style={{marginTop: '1.25rem'}}>
                <div className="gp-header">
                  <span className="gp-title">Conversões Concluídas</span>
                  <span className="gp-percentage">
                    {completedCount} de {validFilesCount} arquivos ({conversionCompletedPercent}%)
                  </span>
                </div>
                <div className="gp-track">
                  <div className="gp-fill conversion" style={{width: `${conversionCompletedPercent}%`}}></div>
                </div>
              </div>

              {/* Contadores específicos rigorosamente separados */}
              <div className="gp-footer">
                {uploadingCount > 0 && (
                  <div className="gp-stat"><div className="dot in-progress"></div>{uploadingCount} enviando</div>
                )}
                {waitingCount > 0 && (
                  <div className="gp-stat"><div className="dot waiting"></div>{waitingCount} na fila</div>
                )}
                {convertingCount > 0 && (
                  <div className="gp-stat"><div className="dot in-progress"></div>{convertingCount} convertendo</div>
                )}
                <div className="gp-stat"><div className="dot completed"></div>{completedCount} concluídos</div>
                {errorCount > 0 && (
                  <div className="gp-stat"><div className="dot error"></div>{errorCount} com falha</div>
                )}
                {!isSseConnected && (
                  <div className="gp-stat reconn" title="Reconectando ao stream de eventos...">
                    <RefreshCw size={12} className="spin-icon" style={{marginRight: '4px'}} /> Reconectando ao progresso...
                  </div>
                )}
              </div>
            </div>
          )}

          {/* LISTA INDIVIDUAL DE ARQUIVOS */}
          <div className="queue-list-pro">
            {files.map(f => {
              const isUploading = f.status === 'Enviando';
              const isConfirming = f.status === 'Confirmando recebimento';
              const isAnalyzing = f.status === 'Analisando vídeo';
              const isConvertingVideo = f.status === 'Convertendo';
              const isFinalizing = f.status === 'Finalizando arquivo';
              const isDone = f.status === 'Concluído';
              const isError = f.status === 'Erro' || f.status === 'Formato não suportado';
              
              let displayPercent = null;
              if (isUploading && f.uploadLengthComputable !== false) {
                displayPercent = `${f.uploadProgress || 0}%`;
              } else if (isConvertingVideo) {
                displayPercent = `${Math.round(normalizeProgress(f.progress))}%`;
              } else if (isDone) {
                displayPercent = '100%';
              }
              
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
                      <span>{getStatusText(f)}</span>
                      {displayPercent && (
                        <span className="job-percentage">{displayPercent}</span>
                      )}
                    </div>
                    
                    <div className="job-progress-wrapper">
                      <div className={`job-progress-bg ${isUploading || isConfirming || isConvertingVideo || isFinalizing ? 'active' : ''} ${isDone ? 'done' : ''} ${isError ? 'error' : ''}`}>
                        <div 
                          className={`job-progress-fill ${f.status} ${isConfirming || isAnalyzing || isFinalizing ? 'indeterminate' : ''}`} 
                          style={{
                            width: `${isUploading ? (f.uploadProgress || 0) : (isDone ? 100 : (isConvertingVideo ? normalizeProgress(f.progress) : (isConfirming || isAnalyzing || isFinalizing ? 100 : 0)))}%`
                          }}
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
                      <div style={{display: 'flex', gap: '6px'}}>
                        {f.status === 'Erro' && (
                          <button className="btn-icon-pro" onClick={() => retryFile(f.id)} title="Tentar novamente">
                            <RotateCcw size={18} />
                          </button>
                        )}
                        <button className="btn-icon-pro" onClick={() => removeFile(f.id)} title="Cancelar / Remover">
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
