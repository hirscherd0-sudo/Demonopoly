const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

const boardData = [
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

let gameState = {
    players: [
        { id: 1, session: null, socketId: null, pos: 0, sanity: 100, icon: '👁', owned: [], active: false, color: '#d00' },
        { id: 2, session: null, socketId: null, pos: 0, sanity: 100, icon: '🕯', owned: [], active: false, color: '#0c6' },
        { id: 3, session: null, socketId: null, pos: 0, sanity: 100, icon: '💀', owned: [], active: false, color: '#00f' },
        { id: 4, session: null, socketId: null, pos: 0, sanity: 100, icon: '🦇', owned: [], active: false, color: '#a0f' }
    ],
    currentPlayerIdx: 0,
    gameStarted: false,
    turnPhase: 'WAITING', 
    activeTrade: null 
};

io.on('connection', (socket) => {
    
    // Neuer Login-Flow: Client sendet 'joinGame' mit SessionID aus localStorage
    socket.on('joinGame', (sessionId) => {
        let player = gameState.players.find(p => p.session === sessionId);
        let myPIdx = -1;

        if (player) {
            // WIEDERKEHRER: Session bekannt
            console.log(`Spieler ${player.id} ist zurückgekehrt.`);
            player.socketId = socket.id;
            player.active = true;
            myPIdx = gameState.players.indexOf(player);
        } else {
            // NEUER SPIELER: Freien Slot suchen
            myPIdx = gameState.players.findIndex(p => !p.session);
            if (myPIdx !== -1) {
                console.log(`Neuer Spieler auf Slot ${myPIdx + 1}`);
                player = gameState.players[myPIdx];
                player.session = sessionId; // Session binden
                player.socketId = socket.id;
                player.active = true;
                // Reset Stats für neuen Spieler
                player.pos = 0;
                player.sanity = 100;
                player.owned = [];
            } else {
                socket.emit('full');
                return;
            }
        }

        // Spielstart Prüfung
        const activeCount = gameState.players.filter(p => p.active).length;
        if (activeCount >= 2 && !gameState.gameStarted) {
            gameState.gameStarted = true;
            gameState.turnPhase = 'ROLL';
            io.emit('log', { msg: "Das Spiel beginnt!", color: "#fff" });
        }

        socket.emit('init', { id: player.id, state: gameState });
        io.emit('updateState', gameState);
    });

    socket.on('rollDice', () => {
        const p = getPlayerBySocket(socket.id);
        if (!p || !gameState.gameStarted) return;
        if (gameState.players[gameState.currentPlayerIdx].id !== p.id) return;
        if (gameState.turnPhase !== 'ROLL') return;

        gameState.turnPhase = 'ANIMATING';
        const roll = Math.floor(Math.random() * 6) + 1;
        
        io.emit('animDice', { roll: roll, pId: p.id });

        setTimeout(() => {
            let newPos = (p.pos + roll) % boardData.length;
            if (newPos < p.pos) {
                p.sanity = Math.min(100, p.sanity + 20);
                io.emit('log', { msg: `P${p.id} passiert START (+20 Sanity).`, color: "#0f0" });
            }
            p.pos = newPos;
            handleLanding(p);
        }, 2000);
    });

    socket.on('decision', (decision) => {
        const p = getPlayerBySocket(socket.id);
        if (!p || gameState.turnPhase !== 'DECISION') return;
        
        const field = boardData[p.pos];
        if (decision === 'buy' && p.sanity > field.price) {
            p.sanity -= field.price;
            p.owned.push(p.pos);
            io.emit('log', { msg: `P${p.id} kauft ${field.name}.`, color: "#0f0" });
        } else {
            io.emit('log', { msg: `P${p.id} zieht weiter.`, color: "#aaa" });
        }
        endTurn();
    });

    // --- HANDELSSYSTEM ---

    socket.on('offerTrade', (data) => {
        const buyer = getPlayerBySocket(socket.id);
        if (!buyer) return;

        const propIdx = parseInt(data.propIdx);
        const offer = parseInt(data.offer);
        
        // Validierung
        const owner = gameState.players.find(p => p.owned.includes(propIdx));
        
        if (!owner) return; // Gehört niemandem
        if (owner.id === buyer.id) return; // Gehört mir selbst
        if (buyer.sanity < offer) return; // Zu wenig Geld

        // Status speichern
        const oldPhase = gameState.turnPhase;
        gameState.turnPhase = 'TRADING';
        gameState.activeTrade = { 
            sourceId: buyer.id, 
            targetId: owner.id, 
            propIdx: propIdx, 
            offer: offer, 
            returnPhase: oldPhase 
        };

        io.emit('updateState', gameState);
        io.emit('tradeRequest', gameState.activeTrade);
        io.emit('log', { msg: `P${buyer.id} bietet P${owner.id} ${offer} Sanity für ${boardData[propIdx].name}.`, color: "#fb0" });
    });

    socket.on('respondTrade', (data) => {
        const trade = gameState.activeTrade;
        const p = getPlayerBySocket(socket.id);
        
        if (!trade || !p || p.id !== trade.targetId) return;

        const buyer = gameState.players.find(pl => pl.id === trade.sourceId);
        const owner = p; // Der Antwortende ist der Besitzer

        if (data.accepted && buyer.sanity >= trade.offer) {
            buyer.sanity -= trade.offer;
            owner.sanity += trade.offer;
            owner.owned = owner.owned.filter(idx => idx !== trade.propIdx);
            buyer.owned.push(trade.propIdx);
            io.emit('log', { msg: `Handel akzeptiert! ${boardData[trade.propIdx].name} gehört nun P${buyer.id}.`, color: "#0f0" });
        } else {
            io.emit('log', { msg: `Handel abgelehnt.`, color: "#f44" });
        }

        gameState.turnPhase = trade.returnPhase;
        gameState.activeTrade = null;
        io.emit('updateState', gameState);
    });

    socket.on('disconnect', () => {
        const p = getPlayerBySocket(socket.id);
        if (p) {
            p.active = false; 
            // WICHTIG: Wir löschen 'session' NICHT, damit er wiederkommen kann!
            // Nur wenn Server neustartet, ist der State weg.
            io.emit('updateState', gameState);
            
            const activeCount = gameState.players.filter(pl => pl.active).length;
            if(activeCount < 2 && gameState.gameStarted) {
                io.emit('log', { msg: "Warte auf Spieler...", color: "#f00" });
            }
        }
    });
});

function getPlayerBySocket(socketId) {
    return gameState.players.find(p => p.socketId === socketId);
}

function handleLanding(p) {
    const field = boardData[p.pos];
    io.emit('updateState', gameState);

    if (field.type === 'prop') {
        const owner = gameState.players.find(pl => pl.owned.includes(p.pos));
        if (owner && owner.id !== p.id) {
            p.sanity -= field.rent;
            owner.sanity += field.rent;
            io.emit('log', { msg: `P${p.id} zahlt ${field.rent} an P${owner.id}.`, color: "#f44" });
            checkGameOver();
            endTurn();
        } else if (!owner && p.sanity > field.price) {
            gameState.turnPhase = 'DECISION';
            gameState.currentFieldPrice = field.price;
            io.emit('updateState', gameState);
        } else {
            endTurn();
        }
    } else if (field.type === 'event') {
         const gain = Math.random() > 0.5;
         if(gain) {
             p.sanity = Math.min(100, p.sanity + 10);
             io.emit('log', { msg: `Event: +10 Sanity`, color: "#fff" });
         } else {
             p.sanity -= 10;
             io.emit('log', { msg: `Event: -10 Sanity`, color: "#f00" });
         }
         checkGameOver();
         setTimeout(endTurn, 2000);
    } else if (field.type === 'go-to-jail') {
        p.pos = 7;
        io.emit('updateState', gameState);
        endTurn();
    } else {
        if (field.type === 'tax') { p.sanity -= field.cost; checkGameOver(); }
        endTurn();
    }
}

function checkGameOver() {
    gameState.players.forEach(p => {
        if (p.active && p.sanity <= 0) {
            io.emit('log', { msg: `P${p.id} IST DEM WAHNSINN VERFALLEN!`, color: "#f00" });
            p.sanity = 0; p.owned = []; 
        }
    });
}

function endTurn() {
    if(!gameState.gameStarted) return;
    let attempts = 0;
    do {
        gameState.currentPlayerIdx = (gameState.currentPlayerIdx + 1) % 4;
        attempts++;
    } while (!gameState.players[gameState.currentPlayerIdx].active && attempts < 5);
    gameState.turnPhase = 'ROLL';
    io.emit('updateState', gameState);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server läuft auf ${PORT}`));


