const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// DAS SPIELFELD
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

// GLOBALE SPIELVARIANBLEN
let gameState = {
    // Jetzt 4 Spieler Slots
    players: [
        { id: 1, socketId: null, pos: 0, sanity: 100, icon: '👁', owned: [], active: false, color: '#f00' },
        { id: 2, socketId: null, pos: 0, sanity: 100, icon: '🕯', owned: [], active: false, color: '#0f9' },
        { id: 3, socketId: null, pos: 0, sanity: 100, icon: '💀', owned: [], active: false, color: '#00f' },
        { id: 4, socketId: null, pos: 0, sanity: 100, icon: '🦇', owned: [], active: false, color: '#a0f' }
    ],
    currentPlayerIdx: 0,
    gameStarted: false,
    turnPhase: 'WAITING', // 'ROLL', 'DECISION', 'ANIMATING', 'TRADING'
    lastRoll: 0,
    currentFieldPrice: 0,
    activeTrade: null // { sourceId, targetId, propIdx, offer }
};

io.on('connection', (socket) => {
    console.log('Verbindung:', socket.id);

    // Freien Slot suchen
    let myPIdx = gameState.players.findIndex(p => !p.active);
    
    if (myPIdx !== -1) {
        gameState.players[myPIdx].socketId = socket.id;
        gameState.players[myPIdx].active = true;
        
        // Spielstart Logik: Startet wenn mindestens 2 Spieler da sind
        const activeCount = gameState.players.filter(p => p.active).length;
        if (activeCount >= 2 && !gameState.gameStarted) {
            gameState.gameStarted = true;
            gameState.turnPhase = 'ROLL';
            io.emit('log', { msg: "Mindestens 2 Spieler bereit. Das Spiel beginnt!", color: "#fff" });
        } else if (activeCount > 1 && gameState.gameStarted) {
             io.emit('log', { msg: `Spieler ${myPIdx+1} ist dem Wahnsinn beigetreten.`, color: "#fff" });
        }

        socket.emit('init', { id: myPIdx + 1, state: gameState });
        io.emit('updateState', gameState);
    } else {
        socket.emit('full');
        return;
    }

    // --- EVENTS ---

    socket.on('rollDice', () => {
        if (!gameState.gameStarted) return;
        if (gameState.currentPlayerIdx !== myPIdx) return;
        if (gameState.turnPhase !== 'ROLL') return;

        gameState.turnPhase = 'ANIMATING';
        const roll = Math.floor(Math.random() * 6) + 1;
        gameState.lastRoll = roll;
        
        io.emit('animDice', { roll: roll, pId: myPIdx + 1 });

        setTimeout(() => {
            const p = gameState.players[myPIdx];
            let newPos = (p.pos + roll) % boardData.length;

            // START BONUS: JETZT NUR NOCH 20
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

        if (decision === 'buy') {
            if (p.sanity > field.price) {
                p.sanity -= field.price;
                p.owned.push(p.pos);
                io.emit('log', { msg: `P${p.id} kauft ${field.name}.`, color: "#0f0" });
            }
        } else {
            io.emit('log', { msg: `P${p.id} verzichtet.`, color: "#aaa" });
        }
        
        endTurn();
    });

    // --- HANDELSSYSTEM ---

    socket.on('offerTrade', (data) => {
        // data: { propIdx, offer }
        if (!gameState.gameStarted) return;
        
        // Darf nur handeln wer dran ist (optional, aber sinnvoller Flow)
        // ODER: Jeder darf immer handeln? Im Brettspiel meistens "jederzeit".
        // Um Chaos zu vermeiden: Nur der aktive Spieler darf handeln.
        if (gameState.currentPlayerIdx !== myPIdx) return; 

        const buyer = gameState.players[myPIdx];
        const propIdx = data.propIdx;
        const offer = parseInt(data.offer);

        // Validierung
        if (buyer.sanity < offer) return; // Zu wenig Geld
        const owner = gameState.players.find(p => p.owned.includes(propIdx));
        if (!owner || owner.id === buyer.id) return; // Gehört niemandem oder mir selbst

        // State auf Trading setzen (blockiert Würfeln)
        const oldPhase = gameState.turnPhase;
        gameState.turnPhase = 'TRADING';
        gameState.activeTrade = {
            sourceId: buyer.id,
            targetId: owner.id,
            propIdx: propIdx,
            offer: offer,
            returnPhase: oldPhase // Damit wir wissen wo wir weitermachen
        };

        io.emit('updateState', gameState);
        io.emit('tradeRequest', gameState.activeTrade);
        io.emit('log', { msg: `P${buyer.id} bietet P${owner.id} ${offer} Sanity für ${boardData[propIdx].name}.`, color: "#fb0" });
    });

    socket.on('respondTrade', (data) => {
        // data: { accepted: boolean }
        const trade = gameState.activeTrade;
        if (!trade) return;
        
        // Nur der Zielspieler darf antworten
        if (gameState.players[myPIdx].id !== trade.targetId) return;

        const buyer = gameState.players.find(p => p.id === trade.sourceId);
        const owner = gameState.players.find(p => p.id === trade.targetId);
        const propName = boardData[trade.propIdx].name;

        if (data.accepted) {
            // Transaktion durchführen
            if (buyer.sanity >= trade.offer) {
                buyer.sanity -= trade.offer;
                owner.sanity += trade.offer;
                
                // Besitz transferieren
                owner.owned = owner.owned.filter(idx => idx !== trade.propIdx);
                buyer.owned.push(trade.propIdx);

                io.emit('log', { msg: `HANDEL: ${propName} gehört nun P${buyer.id}.`, color: "#0f0" });
            } else {
                io.emit('log', { msg: `HANDEL FEHLGESCHLAGEN: P${buyer.id} hat nicht genug Sanity.`, color: "#f00" });
            }
        } else {
            io.emit('log', { msg: `P${owner.id} hat das Angebot abgelehnt.`, color: "#f44" });
        }

        // Reset State
        gameState.turnPhase = trade.returnPhase; // Zurück zum Spielzug (z.B. ROLL oder DECISION)
        gameState.activeTrade = null;
        io.emit('updateState', gameState);
    });

    socket.on('disconnect', () => {
        if(myPIdx !== -1) {
            gameState.players[myPIdx].socketId = null;
            gameState.players[myPIdx].active = false;
            // Wenn weniger als 2 Spieler übrig sind?
            const active = gameState.players.filter(p => p.active).length;
            if (active < 2) {
                gameState.gameStarted = false;
                gameState.turnPhase = 'WAITING';
                io.emit('log', { msg: "Zu wenig Spieler. Warte...", color: "#f00" });
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
        if (owner) {
            if (owner.id === p.id) {
                io.emit('log', { msg: `P${p.id}: Eigener Zufluchtsort.`, color: "#aaa" });
                endTurn();
            } else {
                const rent = field.rent;
                p.sanity -= rent;
                owner.sanity = Math.min(100, owner.sanity + rent);
                io.emit('log', { msg: `P${p.id} zahlt ${rent} an P${owner.id}.`, color: "#f44" });
                checkGameOver();
                endTurn();
            }
        } else {
            if (p.sanity > field.price) {
                gameState.turnPhase = 'DECISION';
                gameState.currentFieldPrice = field.price;
                io.emit('updateState', gameState);
            } else {
                io.emit('log', { msg: `Zu wenig Sanity für ${field.name}.`, color: "#888" });
                endTurn();
            }
        }
    } else if (field.type === 'event') {
        const events = [
            { t: "Gunst", val: 15, text: "Du findest Kraft. (+15)" },
            { t: "Wahnsinn", val: -15, text: "Stimmen plagen dich. (-15)" }
        ];
        const ev = events[Math.floor(Math.random()*2)];
        p.sanity = Math.min(100, p.sanity + ev.val);
        io.emit('showEvent', { title: ev.t, desc: ev.text });
        io.emit('log', { msg: `Event: ${ev.text}`, color: "#fff" });
        checkGameOver();
        setTimeout(endTurn, 3000); 

    } else if (field.type === 'tax') {
        p.sanity -= field.cost;
        io.emit('log', { msg: `Blutopfer: -${field.cost} Sanity.`, color: "#f00" });
        checkGameOver();
        endTurn();
    } else if (field.type === 'go-to-jail') {
        p.pos = 7; 
        io.emit('log', { msg: "VERBANNT in die Leere!", color: "#f00" });
        io.emit('updateState', gameState);
        endTurn();
    } else {
        endTurn();
    }
}

function checkGameOver() {
    gameState.players.forEach(p => {
        if (p.active && p.sanity <= 0) {
            // Find winner (last standing) or just announce loser
            io.emit('log', { msg: `SPIELER ${p.id} IST DEM WAHNSINN VERFALLEN!`, color: "#f00" });
            // Reset player? Or kick?
            p.sanity = 100; // Revive for endless play or handle properly
            p.owned = []; // Lose everything
            p.pos = 0;
            io.emit('updateState', gameState);
        }
    });
}

function endTurn() {
    if(!gameState.gameStarted) return;
    
    // Nächster aktiver Spieler
    let nextIdx = (gameState.currentPlayerIdx + 1) % 4;
    let loopGuard = 0;
    while (!gameState.players[nextIdx].active && loopGuard < 5) {
        nextIdx = (nextIdx + 1) % 4;
        loopGuard++;
    }
    
    gameState.currentPlayerIdx = nextIdx;
    gameState.turnPhase = 'ROLL';
    io.emit('updateState', gameState);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server läuft auf ${PORT}`));


