import React, { useEffect, useRef } from 'react';

const AdSenseBlock = () => {
  const adRef = useRef(null);

  useEffect(() => {
    // Evita inicialização dupla em ambientes StrictMode do React
    if (adRef.current && !adRef.current.getAttribute('data-adsbygoogle-status')) {
      try {
        (window.adsbygoogle = window.adsbygoogle || []).push({});
      } catch (e) {
        console.error('Erro ao inicializar o AdSense:', e);
      }
    }
  }, []);

  return (
    <div className="ads-container" style={{ 
      minHeight: '120px', 
      display: 'flex', 
      justifyContent: 'center', 
      alignItems: 'center',
      margin: '20px auto', 
      width: '100%',
      maxWidth: '1200px',
      overflow: 'hidden'
    }}>
      <ins 
        ref={adRef}
        className="adsbygoogle"
        style={{ display: 'block', width: '100%' }}
        data-ad-client="ca-pub-9462796143464307"
        data-ad-slot="8727499761"
        data-ad-format="auto"
        data-full-width-responsive="true"
      ></ins>
    </div>
  );
};

export default AdSenseBlock;
