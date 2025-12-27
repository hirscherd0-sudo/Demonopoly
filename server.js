const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const fs = require('fs');

app.use(express.static(path.join(__dirname, 'public')));

const DATA_FILE = 'multigame_data.json';
const SAVE_INTERVAL_MS = 5000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000; 
const MAX_INACTIVE_TIME = 2 * 60 * 60 * 1000;

const boardDataTemplate = [
    { name: "START", type: "start" },
    { name: "Keller", type: "prop", price: 15, rent: 4, color: "#300", group: "brown" },
    { name: "Schicksal", type: "event" },
    { name: "Dachboden", type: "prop", price: 18, rent: 5, color: "#300", group: "brown" },
    { name: "Blutopfer", type: "tax", cost: 10 },
    { name: "Ruine", type: "prop", price: 22, rent: 6, color: "#330", group: "yellow" },
    { name: "Flüstergang", type: "event" },
    { name: "VERLASSEN", type: "jail" },
    { name: "Moor", type: "prop", price: 25, rent: 8, color: "#030", group: "green" },
    { name: "Schicksal", type: "event" },
    { name: "Wald", type: "prop", price: 28, rent: 10, color: "#030", group: "green" },
    { name: "Krypta", type: "prop", price: 32, rent: 12, color: "#003", group: "blue" },
    { name: "Irrlichter", type: "event" },
    { name: "Kanzlei", type: "prop", price: 35, rent: 14, color: "#003", group: "blue" },
    { name: "RUHEPOL", type: "free" },
    { name: "Labor", type: "prop", price: 40, rent: 16, color: "#303", group: "pink" },
    { name: "Schicksal", type: "event" },
    { name: "Klinik", type: "prop", price: 45, rent: 18, color: "#303", group: "pink" },
    { name: "Tribut", type: "tax", cost: 15 },
    { name: "Kathedrale", type: "prop", price: 50, rent: 20, color: "#444", group: "grey" },
    { name: "Stimmen", type: "event" },
    { name: "HÖLLENTOR", type: "go-to-jail" },
    { name: "Abgrund", type: "prop", price: 55, rent: 22, color: "#222", group: "dark" },
    { name: "Schicksal", type: "event" },
    { name: "Leere", type: "prop", price: 60, rent: 25, color: "#111", group: "dark" },
    { name: "Zitadelle", type: "prop", price: 70, rent: 30, color: "#000", group: "final" },
    { name: "Flüsterstimmen", type: "event" },
    { name: "ENDSTATION", type: "prop", price: 80, rent: 40, color: "#800", group: "final" }
];

function createNewGameState(roomId) {
    return {
        roomId: roomId,
        lastActivity: Date.now(),
        players: [
            { id: 1, name: "Spieler 1", session: null, socketId: null, pos: 0, sanity: 100, icon: '👁', owned: [], active: false, eliminated: false, color: '#d00' },
            { id: 2, name: "Spieler 2", session: null, socketId: null, pos: 0, sanity: 100, icon: '🕯', owned: [], active: false, eliminated: false, color: '#0c6' },
            { id: 3, name: "Spieler 3", session: null, socketId: null, pos: 0, sanity: 100, icon: '💀', owned: [], active: false, eliminated: false, color: '#00f' },
            { id: 4, name: "Spieler 4", session: null, socketId: null, pos: 0, sanity: 100, icon: '🦇', owned: [], active: false, eliminated: false, color: '#a0f' }
        ],
        currentPlayerIdx: 0,
        gameStarted: false,
        gameEnded: false,
        turnPhase: 'WAITING', 
        activeTrade: null,
        board: JSON.parse(JSON.stringify(boardDataTemplate))
    };
}

let games = {};
let isDirty = false;

// --- CRASH-PROOF LOADING ---
if (fs.existsSync(DATA_FILE)) {
    try {
        const rawData = fs.readFileSync(DATA_FILE, 'utf8');
        if (rawData) {
            games = JSON.parse(rawData);
            // Reset Socket IDs
            for (let rid in games) {
                if(games[rid] && games[rid].players) {
                    games[rid].players.forEach(p => {
                        p.socketId = null;
                        if(!p.name) p.name = `Spieler ${p.id}`; // Fallback für alte Saves
                    });
                }
            }
            console.log(`${Object.keys(games).length} Räume geladen.`);
        }
    } catch (e) {
        console.error("Savegame defekt, starte frisch.", e.message);
        try { fs.unlinkSync(DATA_FILE); } catch(err) {}
        games = {}; 
    }
}

// Asynchron speichern
setInterval(() => {
    if (isDirty) {
        fs.writeFile(DATA_FILE, JSON.stringify(games), () => isDirty = false);
    }
}, SAVE_INTERVAL_MS);

function markDirty() { isDirty = true; }

// Cleanup
setInterval(() => {
    const now = Date.now();
    for (let rid in games) {
        if (now - games[rid].lastActivity > MAX_INACTIVE_TIME) {
            delete games[rid];
            markDirty();
        }
    }
}, CLEANUP_INTERVAL_MS);

function getContext(socketId) {
    for (let rid in games) {
        const game = games[rid];
        const player = game.players.find(p => p.socketId === socketId);
        if (player) {
            game.lastActivity = Date.now();
            markDirty();
            return { game, player, roomId: rid };
        }
    }
    return null;
}

io.on('connection', (socket) => {
    
    socket.on('joinGame', (data) => {
        const sessionId = data.sessionId;
        const playerName = data.name ? data.name.substring(0, 12) : "Unbekannt";

        let foundGame = null;
        let foundPlayer = null;
        let roomIdToJoin = null;

        // Suche existierende Session
        for (let rid in games) {
            const p = games[rid].players.find(pl => pl.session === sessionId);
            if (p) {
                foundGame = games[rid];
                foundPlayer = p;
                roomIdToJoin = rid;
                break;
            }
        }

        if (foundPlayer) {
            // Reconnect
            foundPlayer.socketId = socket.id;
            foundPlayer.active = true;
            foundPlayer.name = playerName; // Name aktualisieren
            foundGame.lastActivity = Date.now();
            socket.join(roomIdToJoin);
            socket.emit('init', { id: foundPlayer.id, state: foundGame, roomName: roomIdToJoin });
            
            if(foundGame.gameStarted) {
                io.to(roomIdToJoin).emit('log', { msg: `${foundPlayer.name} ist zurück.`, color: "#aaa" });
            }
        } else {
            // Neuer Spieler: Freien Raum suchen
            let roomIndex = 1;
            while (true) {
                const rName = `room_${roomIndex}`;
                if (!games[rName]) games[rName] = createNewGameState(rName);

                const game = games[rName];
                // Beitritt nur möglich wenn Spiel nicht beendet
                if (game.gameEnded) { roomIndex++; continue; }

                const freeSlotIdx = game.players.findIndex(p => !p.session && !p.eliminated);
                
                if (freeSlotIdx !== -1) {
                    roomIdToJoin = rName;
                    foundGame = game;
                    foundPlayer = game.players[freeSlotIdx];
                    
                    foundPlayer.session = sessionId;
                    foundPlayer.socketId = socket.id;
                    foundPlayer.active = true;
                    foundPlayer.name = playerName;
                    
                    foundPlayer.pos = 0; foundPlayer.sanity = 100; foundPlayer.owned = []; foundPlayer.eliminated = false;
                    
                    foundGame.lastActivity = Date.now();
                    socket.join(roomIdToJoin);
                    break;
                }
                roomIndex++;
            }
            socket.emit('init', { id: foundPlayer.id, state: foundGame, roomName: roomIdToJoin });
        }
        markDirty();

        const activeCount = foundGame.players.filter(p => p.active && !p.eliminated).length;
        if (activeCount >= 2 && !foundGame.gameStarted) {
            foundGame.gameStarted = true;
            foundGame.turnPhase = 'ROLL';
            io.to(roomIdToJoin).emit('log', { msg: "Das Spiel beginnt!", color: "#fff" });
            markDirty();
        }

        io.to(roomIdToJoin).emit('updateState', foundGame);
    });

    socket.on('rollDice', () => {
        const ctx = getContext(socket.id);
        if (!ctx) return;
        const { game, player, roomId } = ctx;

        if (!game.gameStarted || game.gameEnded || game.players[game.currentPlayerIdx].id !== player.id || game.turnPhase !== 'ROLL') return;

        game.turnPhase = 'ANIMATING';
        const roll = Math.floor(Math.random() * 6) + 1;
        markDirty();
        
        io.to(roomId).emit('animDice', { roll: roll, pId: player.id });

        setTimeout(() => {
            let newPos = (player.pos + roll) % game.board.length;
            if (newPos < player.pos) {
                player.sanity = Math.min(100, player.sanity + 20);
                io.to(roomId).emit('log', { msg: `${player.name}: START (+20).`, color: "#0f0" });
            }
            player.pos = newPos;
            handleLanding(game, player, roomId);
            markDirty();
        }, 2000);
    });

    socket.on('decision', (decision) => {
        const ctx = getContext(socket.id);
        if (!ctx) return;
        const { game, player, roomId } = ctx;
        if (game.turnPhase !== 'DECISION') return;
        
        const field = game.board[player.pos];
        if (decision === 'buy' && player.sanity > field.price) {
            player.sanity -= field.price;
            player.owned.push(player.pos);
            io.to(roomId).emit('log', { msg: `${player.name} kauft ${field.name}.`, color: "#0f0" });
        } else {
            io.to(roomId).emit('log', { msg: `${player.name} zieht weiter.`, color: "#aaa" });
        }
        endTurn(game, roomId);
        markDirty();
    });

    socket.on('offerTrade', (data) => {
        const ctx = getContext(socket.id);
        if (!ctx) return;
        const { game, player: buyer, roomId } = ctx;

        const propIdx = parseInt(data.propIdx);
        const offer = parseInt(data.offer);
        const owner = game.players.find(p => p.owned.includes(propIdx));
        
        if (!owner || owner.id === buyer.id || buyer.sanity < offer) return;

        const oldPhase = game.turnPhase;
        game.turnPhase = 'TRADING';
        game.activeTrade = { sourceId: buyer.id, targetId: owner.id, propIdx, offer, returnPhase: oldPhase };

        io.to(roomId).emit('updateState', game);
        io.to(roomId).emit('tradeRequest', game.activeTrade);
        markDirty();
    });

    socket.on('respondTrade', (data) => {
        const ctx = getContext(socket.id);
        if (!ctx) return;
        const { game, player: owner, roomId } = ctx;
        const trade = game.activeTrade;
        if (!trade || owner.id !== trade.targetId) return;

        const buyer = game.players.find(pl => pl.id === trade.sourceId);

        if (data.accepted && buyer.sanity >= trade.offer) {
            buyer.sanity -= trade.offer;
            owner.sanity += trade.offer;
            owner.owned = owner.owned.filter(idx => idx !== trade.propIdx);
            buyer.owned.push(trade.propIdx);
            io.to(roomId).emit('log', { msg: `Handel erfolgreich!`, color: "#0f0" });
        } else {
            io.to(roomId).emit('log', { msg: `Handel abgelehnt.`, color: "#f44" });
        }
        game.turnPhase = trade.returnPhase;
        game.activeTrade = null;
        io.to(roomId).emit('updateState', game);
        markDirty();
    });

    socket.on('disconnect', () => {
        const ctx = getContext(socket.id);
        if (ctx) {
            ctx.player.active = false;
            io.to(ctx.roomId).emit('updateState', ctx.game);
        }
    });
});

function handleLanding(game, p, roomId) {
    const field = game.board[p.pos];
    io.to(roomId).emit('updateState', game);

    if (field.type === 'prop') {
        const owner = game.players.find(pl => pl.owned.includes(p.pos));
        if (owner && owner.id !== p.id) {
            p.sanity -= field.rent;
            owner.sanity += field.rent;
            io.to(roomId).emit('log', { msg: `${p.name} zahlt Miete (${field.rent}).`, color: "#f44" });
            if (p.sanity <= 0) eliminatePlayer(game, p, roomId);
            else endTurn(game, roomId);
        } else if (!owner && p.sanity > field.price) {
            game.turnPhase = 'DECISION';
            game.currentFieldPrice = field.price;
            io.to(roomId).emit('updateState', game);
        } else {
            endTurn(game, roomId);
        }
    } else if (field.type === 'event') {
         const gain = Math.random() > 0.5;
         let val = gain ? 15 : -15;
         let title = gain ? "LICHTBLICK" : "DUNKLE VISION";
         let txt = gain ? "Du findest eine alte Rune. (+15)" : "Schatten flüstern. (-15)";
         
         p.sanity = Math.min(100, p.sanity + val);
         
         io.to(roomId).emit('showEvent', { title: title, desc: txt, type: gain ? 'good' : 'bad' });
         io.to(roomId).emit('log', { msg: `Event: ${val > 0 ? '+' : ''}${val} Sanity`, color: gain ? "#0f0" : "#f00" });

         if (p.sanity <= 0) setTimeout(() => eliminatePlayer(game, p, roomId), 4000); 
         else setTimeout(() => endTurn(game, roomId), 5000);
         markDirty();

    } else if (field.type === 'go-to-jail') {
        p.pos = 7;
        io.to(roomId).emit('updateState', game);
        endTurn(game, roomId);
    } else {
        if (field.type === 'tax') { 
            p.sanity -= field.cost; 
            if (p.sanity <= 0) eliminatePlayer(game, p, roomId);
            else endTurn(game, roomId);
        } else {
            endTurn(game, roomId);
        }
    }
    markDirty();
}

function eliminatePlayer(game, p, roomId) {
    p.sanity = 0; p.eliminated = true; p.owned = []; 
    io.to(roomId).emit('log', { msg: `${p.name} IST DEM WAHNSINN VERFALLEN!`, color: "#f00" });
    io.to(roomId).emit('updateState', game);
    
    // Check Winner
    const survivors = game.players.filter(pl => pl.session && !pl.eliminated);
    
    if (survivors.length === 1) {
        const winner = survivors[0];
        game.gameEnded = true;
        game.gameStarted = false;
        io.to(roomId).emit('gameOver', { winnerName: winner.name });
        io.to(roomId).emit('log', { msg: `SIEGER: ${winner.name}! Neustart in 10s...`, color: "#0f0" });
        startRestartTimer(game, roomId);
    } else {
        endTurn(game, roomId);
    }
    markDirty();
}

function startRestartTimer(game, roomId) {
    let timeLeft = 10;
    const interval = setInterval(() => {
        timeLeft--;
        io.to(roomId).emit('restartTimer', timeLeft);
        if (timeLeft <= 0) {
            clearInterval(interval);
            resetGame(game, roomId);
        }
    }, 1000);
}

function resetGame(game, roomId) {
    game.gameStarted = true;
    game.gameEnded = false;
    game.currentPlayerIdx = 0;
    game.turnPhase = 'ROLL';
    game.activeTrade = null;
    game.board = JSON.parse(JSON.stringify(boardDataTemplate));

    game.players.forEach(p => {
        if (p.session) {
            p.pos = 0; p.sanity = 100; p.owned = []; p.eliminated = false;
        }
    });

    io.to(roomId).emit('log', { msg: "NEUE RUNDE! Der Wahnsinn beginnt von vorn.", color: "#fff" });
    io.to(roomId).emit('updateState', game);
    markDirty();
}

function endTurn(game, roomId) {
    if(!game.gameStarted || game.gameEnded) return;
    let attempts = 0; let found = false;
    do {
        game.currentPlayerIdx = (game.currentPlayerIdx + 1) % 4;
        const nextP = game.players[game.currentPlayerIdx];
        if (nextP.active && !nextP.eliminated) found = true;
        attempts++;
    } while (!found && attempts < 10);

    game.turnPhase = 'ROLL';
    io.to(roomId).emit('updateState', game);
    markDirty();
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server läuft auf ${PORT}`));


