(() => {
  const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

  // Referencias a elementos del DOM
  const connectionBadge = document.getElementById('connection-badge');
  const connectionText = document.getElementById('connection-text');
  const userBadge = document.getElementById('user-badge');

  const serverErrorBox = document.getElementById('server-error-box');
  const serverErrorTitle = document.getElementById('server-error-title');
  const serverErrorMessage = document.getElementById('server-error-message');
  const dismissErrorBtn = document.getElementById('dismiss-error-btn');

  const joinSection = document.getElementById('join-section');
  const joinForm = document.getElementById('join-form');
  const nameInput = document.getElementById('name-input');
  const joinBtn = document.getElementById('join-btn');

  const appSection = document.getElementById('app-section');
  const participantsCountEl = document.getElementById('participants-count');
  const participantsListEl = document.getElementById('participants-list');

  const proposeForm = document.getElementById('propose-form');
  const productIdsInput = document.getElementById('product-ids-input');
  const pendingProposalsBox = document.getElementById('pending-proposals-box');
  const pendingProposalsList = document.getElementById('pending-proposals-list');

  const proposalResultBox = document.getElementById('proposal-result-box');
  const proposalResultContent = document.getElementById('proposal-result-content');
  const dismissResultBtn = document.getElementById('dismiss-result-btn');

  const productsCountEl = document.getElementById('products-count');
  const productsListEl = document.getElementById('products-list');

  // Estado local reflejado desde el servidor
  let currentUser = null;
  let currentParticipants = [];
  let currentProducts = [];
  let requestCounter = 0;
  /** Propuestas que siguen esperando respuesta del catálogo: requestId -> productIds[] */
  const pendingProposals = new Map();

  // Conexión WebSocket estándar del navegador (sin librerías externas)
  const socket = new WebSocket(wsUrl);
  // Expuesto en window para facilitar pruebas de mensajes inválidos desde DevTools
  window.ws = socket;

  /** Actualiza el indicador visual de estado de la conexión WebSocket. */
  function setConnectionState(connected, label) {
    connectionBadge.classList.toggle('badge-connected', connected);
    connectionBadge.classList.toggle('badge-disconnected', !connected);
    connectionText.textContent = label;
    joinBtn.disabled = !connected;
  }

  /** Muestra en pantalla un error enviado por el servidor (o de conexión). */
  function showServerError(code, message) {
    serverErrorTitle.textContent = code ? `Error (${code})` : 'Error';
    serverErrorMessage.textContent = message;
    serverErrorBox.classList.remove('hidden');
  }

  /** Oculta el cartel de error actual. */
  function hideServerError() {
    serverErrorBox.classList.add('hidden');
  }

  /** Serializa y envía un objeto como JSON si el socket está abierto. */
  function sendJson(payload) {
    if (socket.readyState !== WebSocket.OPEN) {
      showServerError('DISCONNECTED', 'No hay conexión activa con el servidor.');
      return false;
    }
    socket.send(JSON.stringify(payload));
    return true;
  }

  /** Normaliza un nombre para identificar visualmente cuál corresponde a esta pestaña. */
  function normalizeName(name) {
    return name.trim().replace(/\s+/g, ' ').toLowerCase();
  }

  /**
   * Renderiza la lista de participantes conectados usando textContent
   * (evita inyección HTML/XSS con nombres arbitrarios).
   */
  function renderParticipants() {
    participantsCountEl.textContent = String(currentParticipants.length);
    participantsListEl.replaceChildren();

    if (currentParticipants.length === 0) {
      const empty = document.createElement('span');
      empty.className = 'hint';
      empty.textContent = 'Sin participantes conectados.';
      participantsListEl.appendChild(empty);
      return;
    }

    const meKey = currentUser ? normalizeName(currentUser) : null;
    for (const participant of currentParticipants) {
      const chip = document.createElement('span');
      const isMe = meKey !== null && normalizeName(participant) === meKey;
      chip.className = isMe ? 'participant-chip is-me' : 'participant-chip';
      chip.textContent = isMe ? `${participant} (vos)` : participant;
      participantsListEl.appendChild(chip);
    }
  }

  /** Muestra el banner no bloqueante con las propuestas que aún esperan al catálogo. */
  function renderPendingProposals() {
    pendingProposalsList.replaceChildren();

    if (pendingProposals.size === 0) {
      pendingProposalsBox.classList.add('hidden');
      return;
    }

    pendingProposalsBox.classList.remove('hidden');
    for (const [, ids] of pendingProposals) {
      const line = document.createElement('div');
      line.textContent = `Esperando respuesta del catálogo para los IDs: ${ids.join(', ')}...`;
      pendingProposalsList.appendChild(line);
    }
  }

  /**
   * Renderiza el detalle privado de la propuesta: productos efectivamente agregados
   * y motivos individuales de los que fallaron (NOT_FOUND, TIMEOUT, ALREADY_EXISTS, etc.).
   */
  function renderProposalResult(added, failed) {
    proposalResultContent.replaceChildren();

    if (added.length > 0) {
      const addedEl = document.createElement('p');
      addedEl.className = 'result-added';
      const summary = added.map((p) => `#${p.id} ${p.title}`).join(' · ');
      addedEl.textContent = `Agregados (${added.length}): ${summary}`;
      proposalResultContent.appendChild(addedEl);
    }

    if (failed.length > 0) {
      const failedTitle = document.createElement('p');
      failedTitle.textContent = `No se pudieron agregar (${failed.length}):`;
      proposalResultContent.appendChild(failedTitle);

      const ul = document.createElement('ul');
      ul.className = 'result-failed-list';

      for (const failure of failed) {
        const li = document.createElement('li');
        li.className = 'result-failed-item';

        const tag = document.createElement('span');
        tag.className = 'reason-tag';
        tag.textContent = failure.reason;

        const text = document.createElement('span');
        text.textContent = `ID #${failure.productId}: ${failure.message}`;

        li.append(tag, text);
        ul.appendChild(li);
      }

      proposalResultContent.appendChild(ul);
    }

    proposalResultBox.classList.remove('hidden');
  }

  /** Renderiza las tarjetas de productos con datos provistos por el servidor (título, precio e imagen). */
  function renderProducts() {
    productsCountEl.textContent = String(currentProducts.length);
    productsListEl.replaceChildren();

    if (currentProducts.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty-state';
      empty.textContent =
        'Todavía no hay productos en la lista. Proponé alguno usando su ID de DummyJSON (ej. 1, 2, 3).';
      productsListEl.appendChild(empty);
      return;
    }

    for (const product of currentProducts) {
      const card = document.createElement('article');
      card.className = 'product-card';

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

      card.append(img, info);
      productsListEl.appendChild(card);
    }
  }

  // --- Eventos del ciclo de vida del WebSocket ---

  socket.addEventListener('open', () => {
    setConnectionState(true, 'Conectado (WS)');
    nameInput.focus();
  });

  socket.addEventListener('close', () => {
    setConnectionState(false, 'Desconectado');
    pendingProposals.clear();
    renderPendingProposals();
    showServerError(
      'CONNECTION_CLOSED',
      'Se perdió la conexión con el servidor WebSocket. Recargá la página para volver a conectar.'
    );
  });

  socket.addEventListener('error', () => {
    setConnectionState(false, 'Error de conexión');
  });

  socket.addEventListener('message', (event) => {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      console.error('[ws] Mensaje no JSON recibido del servidor:', event.data);
      return;
    }

    switch (message.type) {
      case 'welcome': {
        hideServerError();
        currentUser = message.you;
        currentParticipants = message.participants;
        currentProducts = message.products;

        userBadge.textContent = `Participante: ${currentUser}`;
        userBadge.classList.remove('hidden');
        joinSection.classList.add('hidden');
        appSection.classList.remove('hidden');

        renderParticipants();
        renderProducts();
        productIdsInput.focus();
        break;
      }

      case 'participants_updated': {
        currentParticipants = message.participants;
        renderParticipants();
        break;
      }

      case 'list_updated': {
        currentProducts = message.products;
        renderProducts();
        break;
      }

      case 'proposal_result': {
        if (message.requestId) {
          pendingProposals.delete(message.requestId);
          renderPendingProposals();
        }
        renderProposalResult(message.added, message.failed);
        break;
      }

      case 'error': {
        if (message.requestId) {
          pendingProposals.delete(message.requestId);
          renderPendingProposals();
        }
        console.warn('[ws] Error recibido del servidor:', message);
        showServerError(message.code, message.message);
        break;
      }

      default:
        console.warn('[ws] Mensaje no reconocido:', message);
    }
  });

  // --- Eventos de la interfaz ---

  joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    hideServerError();
    const name = nameInput.value.trim();
    sendJson({ type: 'join', name });
  });

  proposeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    hideServerError();

    // Acepta IDs separados por coma, espacio o punto y coma (ej: "1, 2, 15")
    const rawTokens = productIdsInput.value
      .split(/[\s,;]+/)
      .map((token) => token.trim())
      .filter((token) => token.length > 0);

    if (rawTokens.length === 0) {
      showServerError(
        'INVALID_INPUT',
        'Ingresá al menos un ID numérico de producto (por ejemplo: 1, 2, 15).'
      );
      return;
    }

    // Valida dígitos puros y rango entero seguro (evita pérdida de precisión IEEE-754 con números gigantes)
    const parsedIds = [];
    for (const token of rawTokens) {
      if (!/^\d+$/.test(token)) {
        showServerError(
          'INVALID_INPUT',
          `El valor "${token}" no es un ID entero positivo válido (ej: 1, 2, 10).`
        );
        return;
      }

      const id = Number(token);
      if (!Number.isSafeInteger(id) || id <= 0) {
        showServerError(
          'INVALID_INPUT',
          `El ID "${token}" está fuera del rango numérico permitido (1 a ${Number.MAX_SAFE_INTEGER}).`
        );
        return;
      }

      parsedIds.push(id);
    }

    if (parsedIds.length > 10) {
      showServerError(
        'INVALID_INPUT',
        'Podés proponer como máximo 10 productos por acción.'
      );
      return;
    }

    const requestId = `req-${++requestCounter}`;
    const sent = sendJson({
      type: 'propose_products',
      productIds: parsedIds,
      requestId,
    });

    if (sent) {
      pendingProposals.set(requestId, parsedIds);
      renderPendingProposals();
      productIdsInput.value = '';
    }
  });

  dismissErrorBtn.addEventListener('click', hideServerError);
  dismissResultBtn.addEventListener('click', () => {
    proposalResultBox.classList.add('hidden');
  });
})();
