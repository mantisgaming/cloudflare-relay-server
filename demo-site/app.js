(function () {
    "use strict";

    const HEARTBEAT_INTERVAL_MS = 5000;
    const SOCKET_CONNECT_TIMEOUT_MS = 8000;
    const MAX_LOG_ENTRIES = 250;

    const elements = {
        relayUrlInput: document.getElementById("relayUrlInput"),
        appSecretInput: document.getElementById("appSecretInput"),
        verifyIncomingCheckbox: document.getElementById("verifyIncomingCheckbox"),
        autoAcceptCheckbox: document.getElementById("autoAcceptCheckbox"),
        clearLogButton: document.getElementById("clearLogButton"),
        savedLobbyCode: document.getElementById("savedLobbyCode"),
        savedReconnectKey: document.getElementById("savedReconnectKey"),
        serverStatus: document.getElementById("serverStatus"),
        createServerButton: document.getElementById("createServerButton"),
        reconnectServerButton: document.getElementById("reconnectServerButton"),
        disconnectServerButton: document.getElementById("disconnectServerButton"),
        serverLobbyCode: document.getElementById("serverLobbyCode"),
        serverReconnectKey: document.getElementById("serverReconnectKey"),
        serverSessionKey: document.getElementById("serverSessionKey"),
        peerList: document.getElementById("peerList"),
        refreshPeerListButton: document.getElementById("refreshPeerListButton"),
        serverDestinationsInput: document.getElementById("serverDestinationsInput"),
        serverPayloadInput: document.getElementById("serverPayloadInput"),
        sendServerDataButton: document.getElementById("sendServerDataButton"),
        clientStatus: document.getElementById("clientStatus"),
        addClientButton: document.getElementById("addClientButton"),
        removeClientButton: document.getElementById("removeClientButton"),
        clientRoster: document.getElementById("clientRoster"),
        clientLobbyCodeInput: document.getElementById("clientLobbyCodeInput"),
        joinClientButton: document.getElementById("joinClientButton"),
        disconnectClientButton: document.getElementById("disconnectClientButton"),
        activeClientName: document.getElementById("activeClientName"),
        clientLobbyCode: document.getElementById("clientLobbyCode"),
        clientSessionKey: document.getElementById("clientSessionKey"),
        clientPayloadInput: document.getElementById("clientPayloadInput"),
        sendClientDataButton: document.getElementById("sendClientDataButton"),
        errorBanner: document.getElementById("errorBanner"),
        hideHeartbeatCheckbox: document.getElementById("hideHeartbeatCheckbox"),
        logOutput: document.getElementById("logOutput")
    };

    const state = {
        savedLobbyCode: "",
        savedReconnectKey: "",
        logCount: 0,
        server: createSocketState("server"),
        clients: new Map(),
        nextClientId: 1,
        activeClientId: 0
    };

    function createSocketState(role) {
        return {
            role,
            clientId: 0,
            socket: null,
            sessionKey: "",
            lobbyCode: "",
            reconnectKey: "",
            heartbeatTimer: 0,
            knownPeers: new Map(),
            pendingPeers: new Set(),
            acceptedPeers: new Set(),
            statusClass: "idle",
            statusLabel: "Idle",
            lastError: ""
        };
    }

    function createClientState(clientId) {
        const socketState = createSocketState("client");
        socketState.clientId = clientId;
        return socketState;
    }

    initialize();

    function initialize() {
        const defaultUrl = buildDefaultRelayUrl();
        elements.relayUrlInput.value = defaultUrl;

        elements.createServerButton.addEventListener("click", connectAsServer);
        elements.reconnectServerButton.addEventListener("click", reconnectServer);
        elements.disconnectServerButton.addEventListener("click", function () {
            closeSocket(state.server, 1000, "Server closed from demo UI");
        });
        elements.addClientButton.addEventListener("click", function () {
            addClientSocket(true);
        });
        elements.removeClientButton.addEventListener("click", removeActiveClientSocket);
        elements.joinClientButton.addEventListener("click", connectAsClient);
        elements.disconnectClientButton.addEventListener("click", function () {
            const clientState = getActiveClientState();
            if (!clientState) {
                showError("Select a client socket first.");
                return;
            }

            closeSocket(clientState, 1000, "Client closed from demo UI");
        });
        elements.sendServerDataButton.addEventListener("click", sendServerData);
        elements.sendClientDataButton.addEventListener("click", sendClientData);
        elements.refreshPeerListButton.addEventListener("click", renderPeerList);
        elements.clearLogButton.addEventListener("click", clearLog);
        elements.hideHeartbeatCheckbox.addEventListener("change", updateHeartbeatVisibility);

        addClientSocket(false);

        renderAll();
        log("system", "Demo ready. Configure the relay URL and application secret, then connect.", "success");
    }

    function getClientLabel(clientState) {
        return "Client " + clientState.clientId;
    }

    function getSocketLogTag(socketState) {
        if (socketState.role === "client") {
            return "client-" + socketState.clientId;
        }

        return socketState.role;
    }

    function getActiveClientState() {
        return state.clients.get(state.activeClientId) || null;
    }

    function addClientSocket(announce) {
        const clientId = state.nextClientId;
        state.nextClientId += 1;

        const clientState = createClientState(clientId);
        state.clients.set(clientId, clientState);

        if (!state.activeClientId) {
            state.activeClientId = clientId;
        }

        renderAll();

        if (announce) {
            log("system", getClientLabel(clientState) + " added.", "success");
        }
    }

    function setActiveClient(clientId) {
        if (!state.clients.has(clientId)) {
            return;
        }

        state.activeClientId = clientId;
        clearError();
        renderAll();
    }

    function removeActiveClientSocket() {
        const clientState = getActiveClientState();
        if (!clientState) {
            showError("No client socket is selected.");
            return;
        }

        if (state.clients.size <= 1) {
            showError("At least one client socket must remain.");
            return;
        }

        closeSocket(clientState, 1000, getClientLabel(clientState) + " removed from demo UI", true);
        state.clients.delete(clientState.clientId);

        const nextClient = state.clients.values().next().value || null;
        state.activeClientId = nextClient ? nextClient.clientId : 0;

        renderAll();
        log("system", getClientLabel(clientState) + " removed.");
    }

    function buildDefaultRelayUrl() {
        if (window.location.protocol === "http:" || window.location.protocol === "https:") {
            return window.location.origin + "/relay";
        }

        return "http://127.0.0.1:8787/relay";
    }

    async function connectAsServer() {
        try {
            clearError();
            closeSocket(state.server, 1000, "Replacing existing server socket", true);
            const ws = openSocket(toWebSocketUrl(getRelayBaseUrl()) + "/create", state.server);
            attachSocket(ws, state.server);
            log("server", "Opening server socket with /create.");
            await waitForSocketOpen(ws, "server");
        } catch (error) {
            showError(formatError(error));
        }
    }

    async function reconnectServer() {
        try {
            clearError();
            const lobbyCode = state.savedLobbyCode || state.server.lobbyCode;
            const reconnectKey = state.savedReconnectKey || state.server.reconnectKey;

            if (!lobbyCode || !reconnectKey) {
                throw new Error("Reconnect requires a saved lobby code and reconnect key.");
            }

            closeSocket(state.server, 1000, "Replacing existing server socket", true);
            const wsUrl = toWebSocketUrl(getRelayBaseUrl()) + "/reconnect/" + encodeURIComponent(lobbyCode) + "/" + encodeURIComponent(reconnectKey);
            const ws = openSocket(wsUrl, state.server);
            attachSocket(ws, state.server);
            log("server", "Opening server socket with /reconnect for lobby " + lobbyCode + ".");
            await waitForSocketOpen(ws, "server");
        } catch (error) {
            showError(formatError(error));
        }
    }

    async function connectAsClient() {
        try {
            clearError();
            const clientState = getActiveClientState();
            if (!clientState) {
                throw new Error("Select a client socket first.");
            }

            const lobbyCode = normalizeLobbyCode(elements.clientLobbyCodeInput.value || state.savedLobbyCode);

            if (!lobbyCode) {
                throw new Error("A lobby code is required to join as a client.");
            }

            closeSocket(clientState, 1000, "Replacing existing client socket", true);
            const ws = openSocket(toWebSocketUrl(getRelayBaseUrl()) + "/join/" + encodeURIComponent(lobbyCode), clientState);
            clientState.lobbyCode = lobbyCode;
            clientState.sessionKey = "";
            attachSocket(ws, clientState);
            log(getSocketLogTag(clientState), "Opening client socket for lobby " + lobbyCode + ".");
            await waitForSocketOpen(ws, getClientLabel(clientState).toLowerCase());
            renderAll();
        } catch (error) {
            showError(formatError(error));
        }
    }

    function waitForSocketOpen(ws, role) {
        if (ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        return new Promise(function (resolve, reject) {
            let completed = false;

            const timeoutId = window.setTimeout(function () {
                if (completed) {
                    return;
                }

                completed = true;
                cleanup();

                if (ws.readyState === WebSocket.CONNECTING) {
                    ws.close(1000, "Connect timeout");
                }

                reject(new Error(role + " connection timed out after " + SOCKET_CONNECT_TIMEOUT_MS + "ms."));
            }, SOCKET_CONNECT_TIMEOUT_MS);

            function onOpen() {
                if (completed) {
                    return;
                }

                completed = true;
                cleanup();
                log(role, "Handshake confirmed.", "success");
                resolve();
            }

            function onError() {
                if (completed) {
                    return;
                }

                completed = true;
                cleanup();
                reject(new Error(role + " failed to connect to relay websocket."));
            }

            function onClose(event) {
                if (completed) {
                    return;
                }

                completed = true;
                cleanup();
                const reason = event.reason || "No reason provided";
                reject(new Error(role + " connection closed before handshake completed (" + event.code + "): " + reason + "."));
            }

            function cleanup() {
                window.clearTimeout(timeoutId);
                ws.removeEventListener("open", onOpen);
                ws.removeEventListener("error", onError);
                ws.removeEventListener("close", onClose);
            }

            ws.addEventListener("open", onOpen);
            ws.addEventListener("error", onError);
            ws.addEventListener("close", onClose);
        });
    }

    function openSocket(url, socketState) {
        setSocketStatus(socketState, "connecting", "Connecting");
        return new WebSocket(url);
    }

    function attachSocket(ws, socketState) {
        socketState.socket = ws;

        ws.addEventListener("open", function () {
            log(getSocketLogTag(socketState), "WebSocket open: " + ws.url, "success");
            setSocketStatus(socketState, "connected", "Connected");
            startHeartbeat(socketState);
        });

        ws.addEventListener("message", async function (event) {
            try {
                await handleSocketMessage(socketState, event.data);
            } catch (error) {
                showError(getClientErrorPrefix(socketState) + " message handling failed: " + formatError(error));
            }
        });

        ws.addEventListener("error", function () {
            socketState.lastError = "Browser reported a WebSocket error.";
            setSocketStatus(socketState, "error", "Error");
            showError(getClientErrorPrefix(socketState) + " socket error.");
        });

        ws.addEventListener("close", function (event) {
            stopHeartbeat(socketState);
            const reason = event.reason || "No reason provided";
            log(getSocketLogTag(socketState), "Socket closed with code " + event.code + ": " + reason + ".");

            if (socketState.socket === ws) {
                socketState.socket = null;
            }

            if (socketState.role === "client") {
                socketState.sessionKey = "";
            }

            setSocketStatus(socketState, "idle", "Idle");
            renderAll();
        });
    }

    async function handleSocketMessage(socketState, rawData) {
        if (typeof rawData !== "string") {
            throw new Error("Binary frames are not supported by this demo.");
        }

        if (rawData === "ping") {
            log(getSocketLogTag(socketState), "Received heartbeat ping. Sending pong.", "", { heartbeat: true });
            if (socketState.socket && socketState.socket.readyState === WebSocket.OPEN) {
                socketState.socket.send("pong");
            }
            return;
        }

        if (rawData === "pong") {
            log(getSocketLogTag(socketState), "Received heartbeat pong.", "", { heartbeat: true });
            return;
        }

        if (rawData === "rate_limited") {
            socketState.lastError = "Relay rate limit exceeded.";
            showError(getClientErrorPrefix(socketState) + " was rate limited by the relay.");
            log(getSocketLogTag(socketState), "Relay returned rate_limited.", "error");
            return;
        }

        let packets;
        try {
            packets = JSON.parse(rawData);
        } catch (_error) {
            throw new Error("Incoming message was not valid JSON: " + rawData);
        }

        if (!Array.isArray(packets)) {
            throw new Error("Incoming relay frame must be an array of packets.");
        }

        for (const packet of packets) {
            await handleIncomingPacket(socketState, packet);
        }
    }

    async function handleIncomingPacket(socketState, packet) {
        if (!packet || typeof packet.pld !== "string" || typeof packet.dgs !== "string") {
            throw new Error("Incoming packet did not match { pld, dgs } shape.");
        }

        const payload = JSON.parse(packet.pld);

        if (elements.verifyIncomingCheckbox.checked) {
            const secret = getApplicationSecret(false);
            if (secret) {
                if (payload.msg === "inf") {
                    if (typeof payload.key !== "string" || !payload.key) {
                        showError(getClientErrorPrefix(socketState) + " received an inf packet without a usable key.");
                        log(getSocketLogTag(socketState), "Invalid inf packet key: " + packet.pld, "error");
                        return;
                    }

                    const digestWithNewKey = await createMessageDigest(packet.pld, secret, payload.key);
                    if (digestWithNewKey !== packet.dgs) {
                        showError(getClientErrorPrefix(socketState) + " received an inf packet whose digest did not match the new key.");
                        log(getSocketLogTag(socketState), "Digest mismatch for inf packet: " + packet.pld, "error");
                        return;
                    }
                } else if (socketState.sessionKey) {
                    const digest = await createMessageDigest(packet.pld, secret, socketState.sessionKey);
                    if (digest !== packet.dgs) {
                        showError(getClientErrorPrefix(socketState) + " received a packet whose digest did not verify.");
                        log(getSocketLogTag(socketState), "Digest mismatch for packet: " + packet.pld, "error");
                        return;
                    }
                } else {
                    log(getSocketLogTag(socketState), "Skipping digest check because no session key is available for a non-inf packet.", "error");
                }
            }
        }

        log(getSocketLogTag(socketState), "Packet " + payload.msg + " received: " + JSON.stringify(payload));

        if (socketState.role === "server") {
            await handleServerPayload(payload);
        } else {
            await handleClientPayload(socketState, payload);
        }

        renderAll();
    }

    async function handleServerPayload(payload) {
        if (payload.msg === "inf") {
            state.server.sessionKey = payload.key || "";
            state.server.lobbyCode = normalizeLobbyCode(payload.code || state.server.lobbyCode);
            state.server.reconnectKey = payload.reconnectKey || state.server.reconnectKey;
            state.savedLobbyCode = state.server.lobbyCode;
            state.savedReconnectKey = state.server.reconnectKey;
            elements.clientLobbyCodeInput.value = state.savedLobbyCode;
            log("server", "Server info updated for lobby " + state.server.lobbyCode + ".", "success");
            return;
        }

        if (payload.msg === "con") {
            const peerId = Number(payload.pid);
            rememberPeer(peerId, "pending");

            if (elements.autoAcceptCheckbox.checked) {
                await acceptPeer(peerId);
            }
            return;
        }

        if (payload.msg === "dsc") {
            const peerId = Number(payload.pid);
            forgetPeer(peerId);
            log("server", "Peer " + peerId + " disconnected.");
            return;
        }

        if (payload.msg === "dat") {
            const source = Number(payload.src);
            if (!Number.isNaN(source)) {
                rememberPeer(source, state.server.acceptedPeers.has(source) ? "accepted" : "seen");
            }
            return;
        }
    }

    async function handleClientPayload(clientState, payload) {
        if (payload.msg === "inf") {
            clientState.sessionKey = payload.key || "";
            log(getSocketLogTag(clientState), "Client session key received.", "success");
            return;
        }

        if (payload.msg === "dat") {
            return;
        }
    }

    async function acceptPeer(peerId) {
        await sendSignedPayloads(state.server, [{ msg: "con", pid: peerId }]);
        rememberPeer(peerId, "accepted");
        log("server", "Accepted peer " + peerId + ".", "success");
    }

    async function kickPeer(peerId) {
        await sendSignedPayloads(state.server, [{ msg: "dsc", pid: peerId }]);
        forgetPeer(peerId);
        log("server", "Requested disconnect for peer " + peerId + ".");
        renderPeerList();
    }

    async function sendServerData() {
        try {
            clearError();
            const data = parseJsonField(elements.serverPayloadInput.value, "server payload");
            const destinations = parseDestinations(elements.serverDestinationsInput.value);
            await sendSignedPayloads(state.server, [{ msg: "dat", dat: data, dst: destinations }]);
            log("server", "Sent data packet to peers [" + destinations.join(", ") + "].", "success");
        } catch (error) {
            showError(formatError(error));
        }
    }

    async function sendClientData() {
        try {
            clearError();
            const clientState = getActiveClientState();
            if (!clientState) {
                throw new Error("Select a client socket first.");
            }

            const data = parseJsonField(elements.clientPayloadInput.value, "client payload");
            await sendSignedPayloads(clientState, [{ msg: "dat", dat: data }]);
            log(getSocketLogTag(clientState), "Sent data packet from client.", "success");
        } catch (error) {
            showError(formatError(error));
        }
    }

    async function sendSignedPayloads(socketState, payloads) {
        if (!socketState.socket || socketState.socket.readyState !== WebSocket.OPEN) {
            throw new Error(socketState.role + " socket is not open.");
        }

        const secret = getApplicationSecret(true);
        if (!socketState.sessionKey) {
            throw new Error(socketState.role + " session key is not available yet.");
        }

        const packets = [];
        for (const payload of payloads) {
            const payloadString = JSON.stringify(payload);
            packets.push({
                pld: payloadString,
                dgs: await createMessageDigest(payloadString, secret, socketState.sessionKey)
            });
        }

        socketState.socket.send(JSON.stringify(packets));
    }

    function parseDestinations(value) {
        const normalized = (value || "").trim();
        if (!normalized || normalized === "*") {
            const acceptedPeers = Array.from(state.server.acceptedPeers.values()).sort(function (left, right) {
                return left - right;
            });

            if (!acceptedPeers.length) {
                throw new Error("No accepted peers are available. Accept a client first or enter IDs manually.");
            }

            return acceptedPeers;
        }

        const ids = normalized.split(",").map(function (piece) {
            return Number(piece.trim());
        }).filter(function (valueItem) {
            return Number.isInteger(valueItem) && valueItem >= 0;
        });

        if (!ids.length) {
            throw new Error("Destination peer IDs must be '*' or a comma-separated list of non-negative integers.");
        }

        return ids;
    }

    function parseJsonField(text, fieldName) {
        try {
            return JSON.parse(text);
        } catch (_error) {
            throw new Error("Invalid JSON in " + fieldName + ".");
        }
    }

    function rememberPeer(peerId, stateName) {
        state.server.knownPeers.set(peerId, stateName);

        if (stateName === "pending") {
            state.server.pendingPeers.add(peerId);
            state.server.acceptedPeers.delete(peerId);
        } else if (stateName === "accepted") {
            state.server.pendingPeers.delete(peerId);
            state.server.acceptedPeers.add(peerId);
        }

        renderPeerList();
    }

    function forgetPeer(peerId) {
        state.server.knownPeers.delete(peerId);
        state.server.pendingPeers.delete(peerId);
        state.server.acceptedPeers.delete(peerId);
        renderPeerList();
    }

    function renderPeerList() {
        const entries = Array.from(state.server.knownPeers.entries()).sort(function (left, right) {
            return left[0] - right[0];
        });

        if (!entries.length) {
            elements.peerList.className = "peer-list empty";
            elements.peerList.textContent = "No peers observed yet.";
            return;
        }

        elements.peerList.className = "peer-list";
        elements.peerList.innerHTML = "";

        for (const entry of entries) {
            const peerId = entry[0];
            const peerState = entry[1];
            const row = document.createElement("div");
            row.className = "peer-row";

            const chip = document.createElement("span");
            chip.className = "peer-chip";
            chip.textContent = String(peerId);

            const stateLabel = document.createElement("div");
            stateLabel.className = "peer-state";
            stateLabel.textContent = peerState === "accepted" ? "Accepted" : peerState === "pending" ? "Pending acceptance" : "Observed";

            const acceptButton = document.createElement("button");
            acceptButton.type = "button";
            acceptButton.className = "secondary-button";
            acceptButton.textContent = peerState === "accepted" ? "Accepted" : "Accept";
            acceptButton.disabled = peerState === "accepted";
            acceptButton.addEventListener("click", function () {
                acceptPeer(peerId).catch(function (error) {
                    showError(formatError(error));
                });
            });

            const kickButton = document.createElement("button");
            kickButton.type = "button";
            kickButton.className = "ghost-button";
            kickButton.textContent = "Kick";
            kickButton.addEventListener("click", function () {
                kickPeer(peerId).catch(function (error) {
                    showError(formatError(error));
                });
            });

            row.appendChild(chip);
            row.appendChild(stateLabel);
            row.appendChild(acceptButton);
            row.appendChild(kickButton);
            elements.peerList.appendChild(row);
        }
    }

    function renderAll() {
        const activeClient = getActiveClientState();

        elements.savedLobbyCode.textContent = state.savedLobbyCode || "-";
        elements.savedReconnectKey.textContent = state.savedReconnectKey || "-";
        elements.serverLobbyCode.textContent = state.server.lobbyCode || "-";
        elements.serverReconnectKey.textContent = state.server.reconnectKey || "-";
        elements.serverSessionKey.textContent = elideValue(state.server.sessionKey);
        elements.activeClientName.textContent = activeClient ? getClientLabel(activeClient) : "-";
        elements.clientLobbyCode.textContent = activeClient ? (activeClient.lobbyCode || "-") : "-";
        elements.clientSessionKey.textContent = activeClient ? elideValue(activeClient.sessionKey) : "-";
        elements.clientStatus.className = "status-badge " + (activeClient ? activeClient.statusClass : "idle");
        elements.clientStatus.textContent = activeClient ? activeClient.statusLabel : "Idle";
        elements.removeClientButton.disabled = state.clients.size <= 1;

        renderClientRoster();
        renderPeerList();
    }

    function renderClientRoster() {
        const entries = Array.from(state.clients.values()).sort(function (left, right) {
            return left.clientId - right.clientId;
        });

        if (!entries.length) {
            elements.clientRoster.className = "client-roster empty";
            elements.clientRoster.textContent = "No client sockets created.";
            return;
        }

        elements.clientRoster.className = "client-roster";
        elements.clientRoster.innerHTML = "";

        for (const clientState of entries) {
            const row = document.createElement("div");
            row.className = "client-roster-row" + (clientState.clientId === state.activeClientId ? " selected" : "");

            const chip = document.createElement("span");
            chip.className = "peer-chip";
            chip.textContent = "C" + clientState.clientId;

            const statusChip = document.createElement("span");
            statusChip.className = "peer-chip";
            statusChip.textContent = clientState.statusLabel;

            const label = document.createElement("span");
            label.className = "client-roster-label";
            label.textContent = clientState.lobbyCode ? ("Lobby " + clientState.lobbyCode) : "Not joined";

            const selectButton = document.createElement("button");
            selectButton.type = "button";
            selectButton.className = clientState.clientId === state.activeClientId ? "ghost-button" : "secondary-button";
            selectButton.textContent = clientState.clientId === state.activeClientId ? "Selected" : "Select";
            selectButton.disabled = clientState.clientId === state.activeClientId;
            selectButton.addEventListener("click", function () {
                setActiveClient(clientState.clientId);
            });

            row.appendChild(chip);
            row.appendChild(statusChip);
            row.appendChild(label);
            row.appendChild(selectButton);
            elements.clientRoster.appendChild(row);
        }
    }

    function startHeartbeat(socketState) {
        stopHeartbeat(socketState);
        socketState.heartbeatTimer = window.setInterval(function () {
            if (!socketState.socket || socketState.socket.readyState !== WebSocket.OPEN) {
                return;
            }

            socketState.socket.send("ping");
            log(getSocketLogTag(socketState), "Heartbeat ping sent.", "", { heartbeat: true });
        }, HEARTBEAT_INTERVAL_MS);
    }

    function stopHeartbeat(socketState) {
        if (socketState.heartbeatTimer) {
            window.clearInterval(socketState.heartbeatTimer);
            socketState.heartbeatTimer = 0;
        }
    }

    function closeSocket(socketState, code, reason, silent) {
        stopHeartbeat(socketState);

        if (socketState.socket && socketState.socket.readyState < WebSocket.CLOSING) {
            socketState.socket.close(code, reason);
        }

        if (!silent) {
            log(getSocketLogTag(socketState), reason + ".");
        }
    }

    function getRelayBaseUrl() {
        const value = elements.relayUrlInput.value.trim();
        if (!value) {
            throw new Error("Relay URL is required.");
        }

        return value.replace(/\/$/, "");
    }

    function toWebSocketUrl(inputUrl) {
        const parsed = new URL(inputUrl, window.location.href);
        if (parsed.protocol === "http:") {
            parsed.protocol = "ws:";
        } else if (parsed.protocol === "https:") {
            parsed.protocol = "wss:";
        } else if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
            throw new Error("Relay URL must start with http:, https:, ws:, or wss:.");
        }
        return parsed.toString().replace(/\/$/, "");
    }

    function normalizeLobbyCode(value) {
        return (value || "").trim().toUpperCase();
    }

    function getApplicationSecret(required) {
        const value = elements.appSecretInput.value.trim();
        if (!value) {
            if (required) {
                throw new Error("Application secret is required to send signed packets.");
            }
            return "";
        }

        if (!/^[a-fA-F0-9]+$/.test(value) || value.length % 2 !== 0) {
            throw new Error("Application secret must be an even-length hex string.");
        }

        return value.toLowerCase();
    }

    async function createMessageDigest(payload) {
        const keys = Array.prototype.slice.call(arguments, 1);
        const binaryKeys = keys.map(hexToBytes);
        const payloadBytes = new TextEncoder().encode(payload);

        const totalSize = binaryKeys.reduce(function (size, key) {
            return size + key.length;
        }, payloadBytes.length);

        const data = new Uint8Array(totalSize);
        data.set(payloadBytes, 0);

        let offset = payloadBytes.length;
        for (const key of binaryKeys) {
            data.set(key, offset);
            offset += key.length;
        }

        const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
        return bytesToHex(hash).slice(0, 8);
    }

    function hexToBytes(hex) {
        if (!hex || hex.length % 2 !== 0) {
            throw new Error("Hex values must have an even number of characters.");
        }

        const output = new Uint8Array(hex.length / 2);
        for (let index = 0; index < hex.length; index += 2) {
            output[index / 2] = Number.parseInt(hex.slice(index, index + 2), 16);
        }
        return output;
    }

    function bytesToHex(bytes) {
        return Array.from(bytes).map(function (byte) {
            return byte.toString(16).padStart(2, "0");
        }).join("");
    }

    function setSocketStatus(socketState, className, label) {
        socketState.statusClass = className;
        socketState.statusLabel = label;

        if (socketState.role === "server") {
            elements.serverStatus.className = "status-badge " + className;
            elements.serverStatus.textContent = label;
            return;
        }

        if (socketState.clientId === state.activeClientId) {
            elements.clientStatus.className = "status-badge " + className;
            elements.clientStatus.textContent = label;
        }
    }

    function getClientErrorPrefix(socketState) {
        if (socketState.role !== "client") {
            return socketState.role;
        }

        return getClientLabel(socketState);
    }

    function log(tag, message, kind, options) {
        const isHeartbeat = Boolean(options && options.heartbeat);
        const entry = document.createElement("div");
        entry.className = "log-entry" + (kind ? " " + kind : "");
        if (isHeartbeat) {
            entry.dataset.heartbeat = "true";
        }

        const time = document.createElement("span");
        time.className = "log-time";
        time.textContent = new Date().toLocaleTimeString();

        const logTag = document.createElement("span");
        logTag.className = "log-tag";
        logTag.textContent = "[" + tag + "]";

        const body = document.createElement("span");
        body.className = "log-message";
        body.textContent = message;

        entry.appendChild(time);
        entry.appendChild(logTag);
        entry.appendChild(body);

        elements.logOutput.appendChild(entry);
        if (isHeartbeat && elements.hideHeartbeatCheckbox.checked) {
            entry.style.display = "none";
        }
        elements.logOutput.scrollTop = elements.logOutput.scrollHeight;

        state.logCount += 1;
        while (elements.logOutput.childNodes.length > MAX_LOG_ENTRIES) {
            elements.logOutput.removeChild(elements.logOutput.firstChild);
        }
    }

    function updateHeartbeatVisibility() {
        const hideHeartbeat = elements.hideHeartbeatCheckbox.checked;
        const heartbeatEntries = elements.logOutput.querySelectorAll('[data-heartbeat="true"]');

        for (const heartbeatEntry of heartbeatEntries) {
            heartbeatEntry.style.display = hideHeartbeat ? "none" : "";
        }
    }

    function clearLog() {
        elements.logOutput.innerHTML = "";
        state.logCount = 0;
        clearError();
        log("system", "Log cleared.");
    }

    function showError(message) {
        elements.errorBanner.classList.remove("hidden");
        elements.errorBanner.textContent = message;
        log("error", message, "error");
    }

    function clearError() {
        elements.errorBanner.classList.add("hidden");
        elements.errorBanner.textContent = "No errors";
    }

    function formatError(error) {
        if (error instanceof Error) {
            return error.message;
        }

        return String(error);
    }

    function elideValue(value) {
        if (!value) {
            return "-";
        }

        if (value.length <= 16) {
            return value;
        }

        return value.slice(0, 8) + "..." + value.slice(-8);
    }
})();