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
        { id: 1, socketId: null, pos: 0, sanity: 100, icon: '👁', owned: [], active: false, color: '#ff0000' },
        { id: 2, socketId: null, pos: 0, sanity: 100, icon: '🕯', owned: [], active: false, color: '#00ff99' },
        { id: 3, socketId: null, pos: 0, sanity: 100, icon: '💀', owned: [], active: false, color: '#0088ff' },
        { id: 4, socketId: null, pos: 0, sanity: 100, icon: '🦇', owned: [], active: false, color: '#aa00ff' }
    ],
    currentPlayerIdx: 0,
    gameStarted: false,
    turnPhase: 'WAITING', 
    lastRoll: 0,
    currentFieldPrice: 0,
    activeTrade: null 
};

io.on('connection', (socket) => {
    console.log('User verbunden:', socket.id);

    // Freien Slot suchen
    let myPIdx = gameState.players.findIndex(p => !p.active);
    
    // Wenn Slot gefunden
    if (myPIdx !== -1) {
        gameState.players[myPIdx].socketId = socket.id;
        gameState.players[myPIdx].active = true;
        gameState.players[myPIdx].sanity = 100; // Reset Sanity bei neuem Join
        gameState.players[myPIdx].pos = 0; // Reset Position
        gameState.players[myPIdx].owned = []; // Reset Besitz

        const activeCount = gameState.players.filter(p => p.active).length;

        // Spielstart Logik
        if (activeCount >= 2 && !gameState.gameStarted) {
            gameState.gameStarted = true;
            gameState.currentPlayerIdx = 0; // Immer bei P1 anfangen oder beim ersten aktiven
            // Sicherstellen, dass der Startspieler aktiv ist
            while(!gameState.players[gameState.currentPlayerIdx].active) {
                gameState.currentPlayerIdx = (gameState.currentPlayerIdx + 1) % 4;
            }
            gameState.turnPhase = 'ROLL';
            io.emit('log', { msg: "Das Spiel beginnt! Spieler 1 ist am Zug.", color: "#fff" });
        } else if (gameState.gameStarted) {
             io.emit('log', { msg: `Spieler ${myPIdx+1} ist beigetreten.`, color: "#fff" });
        }

        socket.emit('init', { id: myPIdx + 1, state: gameState });
        io.emit('updateState', gameState);
    } else {
        socket.emit('full');
    }

    // --- LOGIK ---

    socket.on('rollDice', () => {
        if (!gameState.gameStarted) return;
        if (gameState.currentPlayerIdx !== myPIdx) return;
        if (gameState.turnPhase !== 'ROLL') return;

        gameState.turnPhase = 'ANIMATING';
        const roll = Math.floor(Math.random() * 6) + 1;
        
        io.emit('animDice', { roll: roll, pId: myPIdx + 1 });

        // Verzögerung für Animation
        setTimeout(() => {
            const p = gameState.players[myPIdx];
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
        if (gameState.currentPlayerIdx !== myPIdx) return;
        if (gameState.turnPhase !== 'DECISION') return;

        const p = gameState.players[myPIdx];
        const field = boardData[p.pos];

        if (decision === 'buy' && p.sanity > field.price) {
            p.sanity -= field.price;
            p.owned.push(p.pos);
            io.emit('log', { msg: `P${p.id} kauft ${field.name}.`, color: "#0f0" });
        } else {
            io.emit('log', { msg: `P${p.id} kauft nicht.`, color: "#aaa" });
        }
        endTurn();
    });

    // Handel
    socket.on('offerTrade', (data) => {
        if (gameState.currentPlayerIdx !== myPIdx) return; 
        const buyer = gameState.players[myPIdx];
        const offer = parseInt(data.offer);
        const owner = gameState.players.find(p => p.owned.includes(data.propIdx));
        
        if (!owner || owner.id === buyer.id || buyer.sanity < offer) return;

        const oldPhase = gameState.turnPhase;
        gameState.turnPhase = 'TRADING';
        gameState.activeTrade = { sourceId: buyer.id, targetId: owner.id, propIdx: data.propIdx, offer: offer, returnPhase: oldPhase };
        io.emit('updateState', gameState);
        io.emit('tradeRequest', gameState.activeTrade);
    });

    socket.on('respondTrade', (data) => {
        const trade = gameState.activeTrade;
        if (!trade || gameState.players[myPIdx].id !== trade.targetId) return;

        const buyer = gameState.players.find(p => p.id === trade.sourceId);
        const owner = gameState.players.find(p => p.id === trade.targetId);

        if (data.accepted && buyer.sanity >= trade.offer) {
            buyer.sanity -= trade.offer;
            owner.sanity += trade.offer;
            owner.owned = owner.owned.filter(idx => idx !== trade.propIdx);
            buyer.owned.push(trade.propIdx);
            io.emit('log', { msg: `Handel erfolgreich!`, color: "#0f0" });
        } else {
            io.emit('log', { msg: `Handel abgelehnt.`, color: "#f44" });
        }
        gameState.turnPhase = trade.returnPhase;
        gameState.activeTrade = null;
        io.emit('updateState', gameState);
    });

    socket.on('disconnect', () => {
        if(myPIdx !== -1) {
            gameState.players[myPIdx].active = false;
            gameState.players[myPIdx].socketId = null;
            gameState.players[myPIdx].owned = []; // Reset bei Disconnect? Optional.
            
            const activeCount = gameState.players.filter(p => p.active).length;
            
            if (activeCount < 2) {
                gameState.gameStarted = false;
                gameState.turnPhase = 'WAITING';
                io.emit('log', { msg: "Warte auf Spieler...", color: "#f00" });
            } else {
                // Wenn der aktive Spieler geht, Zug beenden
                if (gameState.currentPlayerIdx === myPIdx) {
                    endTurn();
                }
            }
            io.emit('updateState', gameState);
        }
    });
});

function handleLanding(p) {
    const field = boardData[p.pos];
    io.emit('updateState', gameState);

    if (field.type === 'prop') {
        const owner = gameState.players.find(pl => pl.owned.includes(p.pos));
        if (owner && owner.id !== p.id) {
            // Miete
            p.sanity -= field.rent;
            owner.sanity += field.rent;
            io.emit('log', { msg: `P${p.id} zahlt ${field.rent} Miete.`, color: "#f44" });
            checkGameOver();
            endTurn();
        } else if (!owner && p.sanity > field.price) {
            // Kauf möglich
            gameState.turnPhase = 'DECISION';
            gameState.currentFieldPrice = field.price;
            io.emit('updateState', gameState);
        } else {
            endTurn();
        }
    } else if (field.type === 'event') {
         // Vereinfachte Events für schnelleres Gameplay
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
        // Tax, Start, etc.
        if (field.type === 'tax') {
            p.sanity -= field.cost;
            checkGameOver();
        }
        endTurn();
    }
}

function checkGameOver() {
    gameState.players.forEach(p => {
        if (p.active && p.sanity <= 0) {
            io.emit('log', { msg: `P${p.id} IST AUSGESCHIEDEN!`, color: "#f00" });
            p.sanity = 0;
            p.owned = []; // Besitz verlieren
            // Optional: Respawn Logic hier einfügen
        }
    });
}

function endTurn() {
    if(!gameState.gameStarted) return;
    
    // Finde nächsten AKTIVEN Spieler
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


