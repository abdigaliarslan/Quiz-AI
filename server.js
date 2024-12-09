// Импорт необходимых модулей
const express = require('express'); // Для создания веб-сервера
const bodyParser = require('body-parser'); // Для парсинга тела запросов
const axios = require('axios'); // Для выполнения HTTP-запросов
const path = require('path'); // Для работы с файловыми путями
const cors = require('cors'); // Для управления политиками CORS
const http = require('http'); // Для создания HTTP-сервера
const { Server } = require('socket.io'); // Для реализации WebSocket

// Загрузка переменных окружения из файла .env
require('dotenv').config();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY; // Ключ API для работы с OpenAI

const app = express(); // Создание экземпляра приложения Express
const server = http.createServer(app); // Создание HTTP-сервера на базе Express
const io = new Server(server); // Создание экземпляра WebSocket-сервера

const PORT = 3001; // Порт для запуска сервера

// Настройка промежуточного ПО (middleware)
app.use(bodyParser.json()); // Для обработки JSON в запросах
app.use(express.static(path.join(__dirname, 'public'))); // Установка статической директории
app.use(cors()); // Разрешение запросов с других источников
app.use(express.json()); // Для работы с JSON-телами запросов

// Глобальные переменные для хранения данных игры
let rooms = {}; // Список комнат
let players = []; // Список игроков
let currentQuestion = {}; // Текущий вопрос
let questionCounts = {}; // Хранение информации о количестве вопросов для каждой комнаты
let questionHistory = {}; // История заданных вопросов для каждой комнаты

// Обработка запроса на главную страницу
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html')); // Отправка HTML-файла главной страницы
});

// Создание комнаты с указанной темой и количеством вопросов
app.post('/api/create-room', (req, res) => {
  const { roomId, topic, questionCount } = req.body;
  console.log(`Создана комната: ${roomId}, Тема: ${topic}, Вопросов: ${questionCount}`);
  questionCounts[roomId] = { topic, total: questionCount, current: 0 }; // Инициализация данных комнаты
  questionHistory[roomId] = []; // Инициализация истории вопросов
  res.status(201).json({ message: "Комната создана" }); // Ответ на успешное создание комнаты
});

// Обработка запроса на страницу комнаты
app.get('/room', (req, res) => {
  res.sendFile(path.join(__dirname, 'room.html')); // Отправка HTML-файла страницы комнаты
});

// Генерация вопроса с помощью OpenAI
app.post('/generate-question', async (req, res) => {
  const topic = req.body.topic; // Тема для генерации вопроса
  const prompt = `
Сгенерируй вопрос и варианты ответа на русском языке по следующей теме: "${topic}". 
Твой ответ должен быть в формате JSON с полями "question", "answers" и "correctAnswer".
  `;

  try {
    const response = await axios.post(
      'https://api.openai.com/v1/chat/completions',
      {
        model: 'gpt-3.5-turbo', // Используемая модель OpenAI
        messages: [
          { role: 'system', content: 'Генератор вопросов' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 300, // Ограничение длины ответа
      },
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`, // Передача API-ключа в заголовке
        },
      }
    );

    const data = JSON.parse(response.data.choices[0].message.content); // Разбор JSON-ответа
    res.json(data); // Отправка сгенерированного вопроса клиенту
  } catch (error) {
    console.error('Ошибка генерации вопроса:', error.message); // Логирование ошибок
    res.status(500).json({ error: 'Ошибка генерации вопроса' }); // Ответ об ошибке
  }
});

// Обработка событий WebSocket
io.on('connection', (socket) => {
  console.log('Пользователь подключен'); // Логирование подключения пользователя

  // Обработка события начала игры
  socket.on('start', async (roomId) => {
    const roomData = questionCounts[roomId]; // Получение данных комнаты
    if (!roomData) return; // Проверка на существование комнаты

    roomData.current = 0; // Сброс текущего номера вопроса
    questionHistory[roomId] = []; // Очистка истории вопросов
    sendNextQuestion(roomId); // Отправка первого вопроса
  });

  // Обработка события подключения к комнате
  socket.on('join-room', (userID, roomID) => {
    if (!players.some(player => player.id === userID)) { // Проверка, есть ли игрок
      players.push({ id: userID, room: roomID, correct: 0, wrong: 0 }); // Добавление нового игрока
    }

    socket.join(roomID); // Подключение к комнате
    io.to(roomID).emit('players', players.filter(p => p.room === roomID).length); // Обновление количества игроков в комнате
  });

  // Обработка события ответа на вопрос
  socket.on('answer', (answer, userID) => {
    const player = players.find(p => p.id === userID); // Поиск игрока
    if (!player) return;

    if (answer === currentQuestion.correctAnswer) { // Проверка правильности ответа
      player.correct++; // Увеличение счетчика правильных ответов
    } else {
      player.wrong++; // Увеличение счетчика неправильных ответов
    }

    const roomID = player.room; // Получение ID комнаты
    const roomData = questionCounts[roomID];
    if (!roomData) return;

    if (roomData.current >= roomData.total) { // Проверка завершения игры
      const roomPlayers = players.filter(p => p.room === roomID);
      io.to(roomID).emit('end-game', roomPlayers.map(p => ({
        user: p.id,
        correct: p.correct,
        wrong: p.wrong,
      }))); // Отправка итогов игры
    } else {
      sendNextQuestion(roomID); // Отправка следующего вопроса
    }
  });
});

// Функция отправки следующего вопроса
async function sendNextQuestion(roomID) {
  const roomData = questionCounts[roomID]; // Данные комнаты
  if (!roomData) return;

  try {
    let uniqueQuestion = null;
    let attempts = 0;

    // Получение уникального вопроса
    while (!uniqueQuestion && attempts < 5) {
      const response = await axios.post('http://localhost:3001/generate-question', { topic: roomData.topic });
      const newQuestion = response.data;

      if (!questionHistory[roomID].some(q => q.question === newQuestion.question)) {
        uniqueQuestion = newQuestion; // Уникальный вопрос найден
      }

      attempts++;
    }

    if (!uniqueQuestion) {
      console.error('Не удалось получить уникальный вопрос после нескольких попыток');
      return;
    }

    currentQuestion = uniqueQuestion; // Установка текущего вопроса
    questionHistory[roomID].push(currentQuestion); // Добавление вопроса в историю
    roomData.current++; // Увеличение счетчика текущих вопросов

    io.to(roomID).emit('question', currentQuestion); // Отправка вопроса в комнату
  } catch (error) {
    console.error('Ошибка отправки следующего вопроса:', error.message); // Логирование ошибок
  }
}

// Запуск сервера
server.listen(PORT, () => {
  console.log(`Сервер запущен на http://localhost:${PORT}`); // Логирование успешного запуска сервера
});
