const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// DAS SPIELFELD (Datenkonsistenz)
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
    players: [
        { id: 1, socketId: null, pos: 0, sanity: 100, icon: '👁', owned: [], active: false },
        { id: 2, socketId: null, pos: 0, sanity: 100, icon: '🕯', owned: [], active: false }
    ],
    currentPlayerIdx: 0,
    gameStarted: false,
    turnPhase: 'WAITING', // 'ROLL', 'DECISION', 'ANIMATING'
    lastRoll: 0,
    currentFieldPrice: 0 // Hilfsvariable für Kaufentscheidungen
};

io.on('connection', (socket) => {
    console.log('Verbindung:', socket.id);

    // Spieler zuweisen
    let myPIdx = -1;
    if (!gameState.players[0].socketId) {
        gameState.players[0].socketId = socket.id;
        gameState.players[0].active = true;
        myPIdx = 0;
    } else if (!gameState.players[1].socketId) {
        gameState.players[1].socketId = socket.id;
        gameState.players[1].active = true;
        myPIdx = 1;
        gameState.gameStarted = true;
        gameState.turnPhase = 'ROLL';
        io.emit('log', { msg: "Spieler 2 ist da. Der Wahnsinn beginnt!", color: "#fff" });
    } else {
        socket.emit('full');
        return;
    }

    socket.emit('init', { id: myPIdx + 1, state: gameState });
    io.emit('updateState', gameState);

    // --- EVENTS ---

    socket.on('rollDice', () => {
        if (!gameState.gameStarted) return;
        if (gameState.currentPlayerIdx !== myPIdx) return;
        if (gameState.turnPhase !== 'ROLL') return;

        gameState.turnPhase = 'ANIMATING'; // Sperren während Animation
        const roll = Math.floor(Math.random() * 6) + 1;
        gameState.lastRoll = roll;
        
        // 1. Allen sagen: Animation starten (Dauer ca 2 sek)
        io.emit('animDice', { roll: roll, pId: myPIdx + 1 });

        // 2. Verzögert die Logik ausführen
        setTimeout(() => {
            const p = gameState.players[myPIdx];
            let newPos = (p.pos + roll) % boardData.length;

            // Start passiert?
            if (newPos < p.pos) {
                p.sanity = Math.min(100, p.sanity + 50);
                io.emit('log', { msg: `P${p.id} passiert START (+50 Sanity).`, color: "#0f0" });
            }

            p.pos = newPos;
            handleLanding(p);
        }, 2000); // Muss zur Client-Animation passen
    });

    socket.on('decision', (decision) => {
        // decision: 'buy' oder 'pass'
        if (gameState.currentPlayerIdx !== myPIdx) return;
        if (gameState.turnPhase !== 'DECISION') return;

        const p = gameState.players[myPIdx];
        const field = boardData[p.pos];

        if (decision === 'buy') {
            if (p.sanity > field.price) {
                p.sanity -= field.price;
                p.owned.push(p.pos);
                io.emit('log', { msg: `P${p.id} versiegelt ${field.name}.`, color: "#0f0" });
            }
        } else {
            io.emit('log', { msg: `P${p.id} zieht weiter.`, color: "#aaa" });
        }
        
        endTurn();
    });

    socket.on('disconnect', () => {
        gameState.players[myPIdx].socketId = null;
        gameState.players[myPIdx].active = false;
        gameState.gameStarted = false;
        gameState.turnPhase = 'WAITING';
        // Reset Spielstand (optional)
        io.emit('log', { msg: `Spieler ${myPIdx+1} weg. Spiel pausiert.`, color: "#f00" });
        io.emit('updateState', gameState);
    });
});

function handleLanding(p) {
    const field = boardData[p.pos];
    io.emit('updateState', gameState); // Position aktualisieren

    if (field.type === 'prop') {
        const owner = gameState.players.find(pl => pl.owned.includes(p.pos));
        if (owner) {
            if (owner.id === p.id) {
                io.emit('log', { msg: `P${p.id}: Eigener Zufluchtsort.`, color: "#aaa" });
                endTurn();
            } else {
                // Miete zahlen (vereinfacht ohne Farbgruppen für den Moment)
                const rent = field.rent;
                p.sanity -= rent;
                owner.sanity = Math.min(100, owner.sanity + rent);
                io.emit('log', { msg: `P${p.id} zahlt ${rent} Sanity an P${owner.id}.`, color: "#f44" });
                checkGameOver();
                endTurn();
            }
        } else {
            // Niemand besitzt es -> Kaufentscheidung
            if (p.sanity > field.price) {
                gameState.turnPhase = 'DECISION';
                gameState.currentFieldPrice = field.price;
                io.emit('updateState', gameState); // UI zeigt Modal
                // Wir warten nun auf socket.on('decision')
            } else {
                io.emit('log', { msg: `${field.name}: Zu wenig Sanity zum Versiegeln.`, color: "#888" });
                endTurn();
            }
        }
    } else if (field.type === 'event') {
        // Einfaches Zufallsevent
        const events = [
            { t: "Gunst", val: 15, text: "Du findest Kraft. (+15)" },
            { t: "Wahnsinn", val: -15, text: "Stimmen plagen dich. (-15)" }
        ];
        const ev = events[Math.floor(Math.random()*2)];
        p.sanity = Math.min(100, p.sanity + ev.val);
        io.emit('showEvent', { title: ev.t, desc: ev.text }); // Modal nur Info
        io.emit('log', { msg: `Event: ${ev.text}`, color: "#fff" });
        checkGameOver();
        
        // Kurze Pause damit man das Event lesen kann, dann weiter
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
        if (p.sanity <= 0) {
            io.emit('gameOver', p.id === 1 ? 2 : 1);
            gameState.gameStarted = false;
        }
    });
}

function endTurn() {
    if(!gameState.gameStarted) return;
    gameState.currentPlayerIdx = 1 - gameState.currentPlayerIdx;
    gameState.turnPhase = 'ROLL';
    io.emit('updateState', gameState);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log('Server läuft...'));


