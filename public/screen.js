(() => {
  // Referencias a elementos del DOM
  const sseBadge = document.getElementById('sse-badge');
  const sseText = document.getElementById('sse-text');
  const participantsCountEl = document.getElementById('screen-participants-count');
  const productsCountEl = document.getElementById('screen-products-count');
  const updatedAtEl = document.getElementById('screen-updated-at');
  const rankingListEl = document.getElementById('screen-ranking-list');

  /** Actualiza el indicador visual del estado de la suscripción EventSource. */
  function setStatus(connected, label) {
    sseBadge.classList.toggle('badge-connected', connected);
    sseBadge.classList.toggle('badge-disconnected', !connected);
    sseText.textContent = label;
  }

  /** Formatea una fecha ISO recibida del servidor a hora local legible (HH:MM:SS). */
  function formatTime(isoString) {
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) {
      return '—';
    }
    return date.toLocaleTimeString('es-AR', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  /**
   * Renderiza el ranking completo en formato grande para pantalla compartida.
   * Usa exclusivamente textContent para prevenir inyección HTML/XSS.
   */
  function renderRanking(products) {
    productsCountEl.textContent = String(products.length);
    rankingListEl.replaceChildren();

    if (products.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent = 'Aún no se propusieron productos para el regalo.';
      rankingListEl.appendChild(empty);
      return;
    }

    products.forEach((product, index) => {
      const card = document.createElement('article');
      card.className = 'product-card screen-product-card';

      const rank = document.createElement('div');
      rank.className = index === 0 ? 'product-rank rank-1' : 'product-rank';
      rank.textContent = `#${index + 1}`;

      const img = document.createElement('img');
      img.className = 'product-thumb';
      img.alt = product.title;
      if (product.image) {
        img.src = product.image;
      }

      const info = document.createElement('div');
      info.className = 'product-info';

      const title = document.createElement('div');
      title.className = 'product-title';
      title.textContent = product.title;

      const meta = document.createElement('div');
      meta.className = 'product-meta';

      const price = document.createElement('span');
      price.className = 'product-price';
      price.textContent = `$${product.price.toFixed(2)}`;

      const idSpan = document.createElement('span');
      idSpan.textContent = `ID #${product.id}`;

      const proposer = document.createElement('span');
      proposer.textContent = `Propuesto por ${product.proposedBy}`;

      meta.append(price, idSpan, proposer);
      info.append(title, meta);

      const votesBox = document.createElement('div');
      votesBox.className = 'screen-votes-big';

      const votesNumber = document.createElement('div');
      votesNumber.className = 'screen-votes-number';
      votesNumber.textContent = String(product.votesCount);

      const votesLabel = document.createElement('div');
      votesLabel.className = 'screen-votes-label';
      votesLabel.textContent = product.votesCount === 1 ? 'voto' : 'votos';

      votesBox.append(votesNumber, votesLabel);

      card.append(rank, img, info, votesBox);
      rankingListEl.appendChild(card);
    });
  }

  // --- Suscripción unidireccional por Server-Sent Events (API EventSource nativa) ---
  // La pantalla nunca envía datos al servidor: solo escucha los eventos que este emite.
  const source = new EventSource('/events');

  source.addEventListener('open', () => {
    setStatus(true, 'En vivo (SSE)');
  });

  source.addEventListener('error', () => {
    setStatus(false, 'Sin conexión / reconectando...');
  });

  // Estado inicial completo enviado apenas se abre el stream
  source.addEventListener('snapshot', (event) => {
    const data = JSON.parse(event.data);
    participantsCountEl.textContent = String(data.participantsCount);
    updatedAtEl.textContent = formatTime(data.updatedAt);
    renderRanking(data.products);
  });

  // Actualización del ranking cuando cambia algún producto o voto
  source.addEventListener('ranking_updated', (event) => {
    const data = JSON.parse(event.data);
    participantsCountEl.textContent = String(data.participantsCount);
    updatedAtEl.textContent = formatTime(data.updatedAt);
    renderRanking(data.products);
  });

  // Actualización liviana cuando solo cambia la cantidad de participantes conectados
  source.addEventListener('participants_updated', (event) => {
    const data = JSON.parse(event.data);
    participantsCountEl.textContent = String(data.participantsCount);
    updatedAtEl.textContent = formatTime(data.updatedAt);
  });
})();
