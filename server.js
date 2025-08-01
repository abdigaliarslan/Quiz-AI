 
const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const path = require('path');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');


require('dotenv').config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3001;

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, 'public')));
app.use(cors());
app.use(express.json());

let rooms = {};
let timers = {};

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/api/create-room', (req, res) => {
  const { roomId, topic, questionCount } = req.body;
  rooms[roomId] = {
    topic,
    totalQuestions: questionCount,
    currentQuestionIndex: 0,
    players: [],
    history: [],
    answers: {},
    scores: {}  
  };
  res.status(201).json({ message: "Комната создана" });
});

app.get('/room', (req, res) => {
  res.sendFile(path.join(__dirname, 'room.html'));
});

app.post('/generate-question', async (req, res) => {
  const topic = req.body.topic;
  const prompt = `
Сгенерируй вопрос уровня 9–11 классов по следующей теме: "${topic}". 
Вопрос должен быть сложным и рассчитанным на старшеклассников. 
Пример: углубленные вопросы по математике, физике, химии, биологии, истории или литературе.
Вопросы должны проверять знания, понимание темы и требовать осмысленного выбора. 
Твой ответ должен быть в формате JSON:
{
  "question": "Текст вопроса",
  "answers": ["Вариант 1", "Вариант 2", "Вариант 3", "Вариант 4"],
  "correctAnswer": "Правильный вариант"
}
  `;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: 'Ты генератор сложных вопросов уровня 9–11 классов.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300,
        temperature: 0.7,  
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
      }
    );

    const data = JSON.parse(response.data.choices[0].message.content);
    res.json(data);
  } catch (error) {
    console.error('Ошибка генерации вопроса:', error.message);
    res.status(500).json({ error: 'Ошибка генерации вопроса' });
  }
});


io.on('connection', (socket) => {
  socket.on('join-room', (userID, roomID) => {
    const room = rooms[roomID];
    if (!room) return;

    if (!room.players.includes(userID)) {
      room.players.push(userID);
      room.scores[userID] = 0;  
    }

    socket.join(roomID);
    io.to(roomID).emit('players', room.players.length);
  });

  socket.on('start', (roomID) => {
    const room = rooms[roomID];
    if (!room) return;

    room.currentQuestionIndex = 0;
    room.answers = {};
    room.history = [];
    // Сброс счетов
    for (let player of room.players) {
      room.scores[player] = 0;
    }
    sendNextQuestion(roomID);
  });

  socket.on('answer', (roomID, userID, answer) => {
    const room = rooms[roomID];
    if (!room) return;

    room.answers[userID] = answer;

     if (Object.keys(room.answers).length === room.players.length) {
      clearTimeout(timers[roomID]);  
      evaluateAnswers(roomID);
    }
  });
});

async function sendNextQuestion(roomID) {
  const room = rooms[roomID];
  if (!room) return;

  try {
    let uniqueQuestion = null;
    let attempts = 0;

    while (!uniqueQuestion && attempts < 5) {
      const response = await axios.post('http://localhost:3001/generate-question', { topic: room.topic });
      const newQuestion = response.data;

      if (!room.history.some(q => q.question === newQuestion.question)) {
        uniqueQuestion = newQuestion;
      }
      attempts++;
    }

    if (!uniqueQuestion) {
      console.error('Не удалось получить уникальный вопрос после нескольких попыток');
      return;
    }

    room.history.push(uniqueQuestion);
    room.currentQuestionIndex++;
    room.answers = {};

    io.to(roomID).emit('question', uniqueQuestion);

   
    let countdown = 15;
    timers[roomID] = setInterval(() => {
      io.to(roomID).emit('timer', countdown);

      if (countdown === 0) {
        clearInterval(timers[roomID]);
        evaluateAnswers(roomID);
      } else {
        countdown--;
      }
    }, 1000);
  } catch (error) {
    console.error('Ошибка отправки следующего вопроса:', error.message);
  }
}

function evaluateAnswers(roomID) {
  const room = rooms[roomID];
  if (!room) return;

  const correctAnswer = room.history[room.currentQuestionIndex - 1].correctAnswer;

  for (let player of room.players) {
    const playerAnswer = room.answers[player];
    if (playerAnswer === correctAnswer) {
      room.scores[player] = (room.scores[player] || 0) + 1;
    }
  }

   if (room.currentQuestionIndex >= room.totalQuestions) {
    const maxScore = Math.max(...Object.values(room.scores));
    const winners = Object.keys(room.scores).filter(p => room.scores[p] === maxScore);

    let results = {};
    for (let player of room.players) {
      results[player] = {
        correct: room.scores[player] || 0,
        wrong: room.totalQuestions - (room.scores[player] || 0),
      };
    }

    if (winners.length === 1) {
      
      io.to(roomID).emit('end-game', { results, winner: winners[0], draw: false });
    } else {
       io.to(roomID).emit('end-game', { results, draw: true });
    }
  } else {
     setTimeout(() => sendNextQuestion(roomID), 3000);
  }
}


server.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`);
});
