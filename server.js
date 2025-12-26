const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

// Statische Dateien aus dem 'public' Ordner bereitstellen
app.use(express.static(path.join(__dirname, 'public')));

// SPIELZUSTAND (Global auf dem Server)
let gameState = {
    players: [
        { id: 1, socketId: null, pos: 0, sanity: 100, icon: '👁', owned: [], name: "Spieler 1" },
        { id: 2, socketId: null, pos: 0, sanity: 100, icon: '🕯', owned: [], name: "Spieler 2" }
    ],
    currentPlayerIdx: 0,
    gameStarted: false,
    log: []
};

// Das Spielfeld (Daten müssen auf dem Server bekannt sein)
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

io.on('connection', (socket) => {
    console.log('Ein Benutzer hat sich verbunden:', socket.id);

    // Spieler zuweisen
    let myPlayerIndex = -1;
    if (!gameState.players[0].socketId) {
        gameState.players[0].socketId = socket.id;
        myPlayerIndex = 0;
    } else if (!gameState.players[1].socketId) {
        gameState.players[1].socketId = socket.id;
        myPlayerIndex = 1;
        gameState.gameStarted = true; // Spiel startet wenn P2 da ist
        io.emit('log', "Spieler 2 ist beigetreten. Der Wahnsinn beginnt!");
    } else {
        socket.emit('full', true); // Spiel ist voll
        return;
    }

    // Dem Client sagen, wer er ist
    socket.emit('init', { 
        id: myPlayerIndex + 1, 
        state: gameState 
    });

    // Allen sagen, dass sich was geändert hat
    io.emit('updateState', gameState);

    // --- EVENTS VOM CLIENT ---

    socket.on('rollDice', () => {
        // Ist der Spieler dran?
        if (gameState.currentPlayerIdx !== myPlayerIndex) return;
        if (!gameState.gameStarted) return;

        const roll = Math.floor(Math.random() * 6) + 1;
        const player = gameState.players[myPlayerIndex];
        
        // Logik auf dem Server berechnen
        let newPos = (player.pos + roll) % boardData.length;
        
        // START passiert?
        if (newPos < player.pos) {
            player.sanity = Math.min(100, player.sanity + 20); // Etwas weniger Heilung für mehr Spannung
        }
        
        player.pos = newPos;
        
        io.emit('diceRolled', { roll: roll, playerId: player.id });
        io.emit('log', `P${player.id} würfelt eine ${roll}.`);
        
        // Landung berechnen (vereinfacht für Server)
        handleLanding(player, newPos);
        
        io.emit('updateState', gameState);
    });

    socket.on('buyProperty', () => {
        if (gameState.currentPlayerIdx !== myPlayerIndex) return;
        const p = gameState.players[myPlayerIndex];
        const field = boardData[p.pos];

        if (field.type === 'prop' && p.sanity > field.price) {
             // Check if already owned (Sicherheit)
             const alreadyOwned = gameState.players.some(pl => pl.owned.includes(p.pos));
             if(!alreadyOwned) {
                 p.sanity -= field.price;
                 p.owned.push(p.pos);
                 io.emit('log', `P${p.id} kauft ${field.name}.`, "#0f0");
                 nextTurn();
             }
        }
    });

    socket.on('endTurn', () => {
        if (gameState.currentPlayerIdx !== myPlayerIndex) return;
        nextTurn();
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
        gameState.players[myPlayerIndex].socketId = null;
        gameState.gameStarted = false;
        io.emit('log', `P${myPlayerIndex + 1} hat die Verbindung verloren.`, "#f00");
        // Reset optionale hier einfügen wenn gewünscht
    });
});

function handleLanding(player, pos) {
    const field = boardData[pos];
    // Logik prüfen
    if (field.type === 'prop') {
        const owner = gameState.players.find(p => p.owned.includes(pos));
        if (owner && owner.id !== player.id) {
            // Miete zahlen
            const rent = field.rent; // Hier könnte man noch Farbgruppen-Logik einbauen
            player.sanity -= rent;
            owner.sanity += rent / 2; // Kleiner Bonus für Vermieter
            io.emit('log', `P${player.id} zahlt ${rent} Miete an P${owner.id}.`, "#f44");
            nextTurn();
        } else if (owner && owner.id === player.id) {
            io.emit('log', `P${player.id} ruht sich im eigenen Haus aus.`);
            nextTurn();
        } else {
            // Kaufen möglich -> Warten auf Client Input
            // Wir beenden den Zug NICHT hier, sondern warten auf 'buyProperty' oder 'endTurn' vom Client
        }
    } else if (field.type === 'tax') {
        player.sanity -= field.cost;
        io.emit('log', `Blutopfer: -${field.cost} Sanity.`, "#f00");
        nextTurn();
    } else if (field.type === 'go-to-jail') {
        player.pos = 7; // Index für Gefängnis
        io.emit('log', `P${player.id} wurde verbannt!`, "#f00");
        nextTurn();
    } else if (field.type === 'event') {
         // Zufallsevent
         const r = Math.random();
         if(r < 0.33) {
             player.sanity -= 10;
             io.emit('log', `Event: Wahnsinnige Visionen (-10 Sanity).`);
         } else if (r < 0.66) {
             player.sanity += 10;
             io.emit('log', `Event: Ein Moment der Klarheit (+10 Sanity).`);
         } else {
             // Teleport
             player.pos = (player.pos + 3) % 28;
             io.emit('log', `Event: Stimmen rufen dich vorwärts.`);
         }
         nextTurn();
    } else {
        // Start, Free Parking, etc.
        nextTurn();
    }
}

function nextTurn() {
    // Game Over Check
    if(gameState.players.some(p => p.sanity <= 0)) {
        io.emit('gameOver', gameState.players.find(p => p.sanity > 0).id);
        return;
    }

    gameState.currentPlayerIdx = 1 - gameState.currentPlayerIdx;
    io.emit('updateState', gameState);
}

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});

