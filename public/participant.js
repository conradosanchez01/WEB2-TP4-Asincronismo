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

  // Estado local reflejado desde el servidor
  let currentUser = null;
  let currentParticipants = [];

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

  // --- Eventos del ciclo de vida del WebSocket ---

  socket.addEventListener('open', () => {
    setConnectionState(true, 'Conectado (WS)');
    nameInput.focus();
  });

  socket.addEventListener('close', () => {
    setConnectionState(false, 'Desconectado');
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

        userBadge.textContent = `Participante: ${currentUser}`;
        userBadge.classList.remove('hidden');
        joinSection.classList.add('hidden');
        appSection.classList.remove('hidden');

        renderParticipants();
        break;
      }

      case 'participants_updated': {
        currentParticipants = message.participants;
        renderParticipants();
        break;
      }

      case 'error': {
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

  dismissErrorBtn.addEventListener('click', hideServerError);
})();
