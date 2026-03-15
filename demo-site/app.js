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
        clientLobbyCodeInput: document.getElementById("clientLobbyCodeInput"),
        joinClientButton: document.getElementById("joinClientButton"),
        disconnectClientButton: document.getElementById("disconnectClientButton"),
        clientLobbyCode: document.getElementById("clientLobbyCode"),
        clientSessionKey: document.getElementById("clientSessionKey"),
        clientPayloadInput: document.getElementById("clientPayloadInput"),
        sendClientDataButton: document.getElementById("sendClientDataButton"),
        errorBanner: document.getElementById("errorBanner"),
        logOutput: document.getElementById("logOutput")
    };

    const state = {
        savedLobbyCode: "",
        savedReconnectKey: "",
        logCount: 0,
        server: createSocketState("server"),
        client: createSocketState("client")
    };

    function createSocketState(role) {
        return {
            role,
            socket: null,
            sessionKey: "",
            lobbyCode: "",
            reconnectKey: "",
            heartbeatTimer: 0,
            knownPeers: new Map(),
            pendingPeers: new Set(),
            acceptedPeers: new Set(),
            lastError: ""
        };
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
        elements.joinClientButton.addEventListener("click", connectAsClient);
        elements.disconnectClientButton.addEventListener("click", function () {
            closeSocket(state.client, 1000, "Client closed from demo UI");
        });
        elements.sendServerDataButton.addEventListener("click", sendServerData);
        elements.sendClientDataButton.addEventListener("click", sendClientData);
        elements.refreshPeerListButton.addEventListener("click", renderPeerList);
        elements.clearLogButton.addEventListener("click", clearLog);

        renderAll();
        log("system", "Demo ready. Configure the relay URL and application secret, then connect.", "success");
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
            const lobbyCode = normalizeLobbyCode(elements.clientLobbyCodeInput.value || state.savedLobbyCode);

            if (!lobbyCode) {
                throw new Error("A lobby code is required to join as a client.");
            }

            closeSocket(state.client, 1000, "Replacing existing client socket", true);
            const ws = openSocket(toWebSocketUrl(getRelayBaseUrl()) + "/join/" + encodeURIComponent(lobbyCode), state.client);
            state.client.lobbyCode = lobbyCode;
            attachSocket(ws, state.client);
            log("client", "Opening client socket for lobby " + lobbyCode + ".");
            await waitForSocketOpen(ws, "client");
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
        updateStatus(socketState.role, "connecting", "Connecting");
        return new WebSocket(url);
    }

    function attachSocket(ws, socketState) {
        socketState.socket = ws;

        ws.addEventListener("open", function () {
            log(socketState.role, "WebSocket open: " + ws.url, "success");
            updateStatus(socketState.role, "connected", "Connected");
            startHeartbeat(socketState);
        });

        ws.addEventListener("message", async function (event) {
            try {
                await handleSocketMessage(socketState, event.data);
            } catch (error) {
                showError(socketState.role + " message handling failed: " + formatError(error));
            }
        });

        ws.addEventListener("error", function () {
            socketState.lastError = "Browser reported a WebSocket error.";
            updateStatus(socketState.role, "error", "Error");
            showError(socketState.role + " socket error.");
        });

        ws.addEventListener("close", function (event) {
            stopHeartbeat(socketState);
            const reason = event.reason || "No reason provided";
            log(socketState.role, "Socket closed with code " + event.code + ": " + reason + ".");

            if (socketState.socket === ws) {
                socketState.socket = null;
            }

            if (socketState.role === "client") {
                socketState.sessionKey = "";
            }

            updateStatus(socketState.role, "idle", "Idle");
            renderAll();
        });
    }

    async function handleSocketMessage(socketState, rawData) {
        if (typeof rawData !== "string") {
            throw new Error("Binary frames are not supported by this demo.");
        }

        if (rawData === "ping") {
            log(socketState.role, "Received heartbeat ping. Sending pong.");
            if (socketState.socket && socketState.socket.readyState === WebSocket.OPEN) {
                socketState.socket.send("pong");
            }
            return;
        }

        if (rawData === "pong") {
            log(socketState.role, "Received heartbeat pong.");
            return;
        }

        if (rawData === "rate_limited") {
            socketState.lastError = "Relay rate limit exceeded.";
            showError(socketState.role + " was rate limited by the relay.");
            log(socketState.role, "Relay returned rate_limited.", "error");
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
                        showError(socketState.role + " received an inf packet without a usable key.");
                        log(socketState.role, "Invalid inf packet key: " + packet.pld, "error");
                        return;
                    }

                    const digestWithNewKey = await createMessageDigest(packet.pld, secret, payload.key);
                    if (digestWithNewKey !== packet.dgs) {
                        showError(socketState.role + " received an inf packet whose digest did not match the new key.");
                        log(socketState.role, "Digest mismatch for inf packet: " + packet.pld, "error");
                        return;
                    }
                } else if (socketState.sessionKey) {
                    const digest = await createMessageDigest(packet.pld, secret, socketState.sessionKey);
                    if (digest !== packet.dgs) {
                        showError(socketState.role + " received a packet whose digest did not verify.");
                        log(socketState.role, "Digest mismatch for packet: " + packet.pld, "error");
                        return;
                    }
                } else {
                    log(socketState.role, "Skipping digest check because no session key is available for a non-inf packet.", "error");
                }
            }
        }

        log(socketState.role, "Packet " + payload.msg + " received: " + JSON.stringify(payload));

        if (socketState.role === "server") {
            await handleServerPayload(payload);
        } else {
            await handleClientPayload(payload);
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

    async function handleClientPayload(payload) {
        if (payload.msg === "inf") {
            state.client.sessionKey = payload.key || "";
            log("client", "Client session key received.", "success");
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
            const data = parseJsonField(elements.clientPayloadInput.value, "client payload");
            await sendSignedPayloads(state.client, [{ msg: "dat", dat: data }]);
            log("client", "Sent data packet from client.", "success");
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
        elements.savedLobbyCode.textContent = state.savedLobbyCode || "-";
        elements.savedReconnectKey.textContent = state.savedReconnectKey || "-";
        elements.serverLobbyCode.textContent = state.server.lobbyCode || "-";
        elements.serverReconnectKey.textContent = state.server.reconnectKey || "-";
        elements.serverSessionKey.textContent = elideValue(state.server.sessionKey);
        elements.clientLobbyCode.textContent = state.client.lobbyCode || "-";
        elements.clientSessionKey.textContent = elideValue(state.client.sessionKey);
        renderPeerList();
    }

    function startHeartbeat(socketState) {
        stopHeartbeat(socketState);
        socketState.heartbeatTimer = window.setInterval(function () {
            if (!socketState.socket || socketState.socket.readyState !== WebSocket.OPEN) {
                return;
            }

            socketState.socket.send("ping");
            log(socketState.role, "Heartbeat ping sent.");
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
            log(socketState.role, reason + ".");
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

    function updateStatus(role, className, label) {
        const badge = role === "server" ? elements.serverStatus : elements.clientStatus;
        badge.className = "status-badge " + className;
        badge.textContent = label;
    }

    function log(tag, message, kind) {
        const entry = document.createElement("div");
        entry.className = "log-entry" + (kind ? " " + kind : "");

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
        elements.logOutput.scrollTop = elements.logOutput.scrollHeight;

        state.logCount += 1;
        while (elements.logOutput.childNodes.length > MAX_LOG_ENTRIES) {
            elements.logOutput.removeChild(elements.logOutput.firstChild);
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