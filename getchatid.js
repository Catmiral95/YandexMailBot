require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {polling: true});

bot.on('message', (msg) => {
    console.log(`📱 Новый пользователь:`);
    console.log(`   Chat ID: ${msg.chat.id}`);
    console.log(`   Имя: ${msg.from.first_name} ${msg.from.last_name || ''}`);
    console.log(`   Username: @${msg.from.username || 'нет'}`);
    console.log(`\nДобавьте в .env:`);
    console.log(`YANDEX_USER_N=почта@yandex.ru`);
    console.log(`YANDEX_PASS_N=пароль_приложения`);
    console.log(`YANDEX_CHAT_ID_N=${msg.chat.id}`);
    
    bot.sendMessage(msg.chat.id, 
        `Ваш Chat ID: ${msg.chat.id}\n\n` +
        `Сообщите этот ID администратору для подключения Яндекс.Почты.`
    );
});

console.log('Бот запущен. Отправьте ему сообщение чтобы получить Chat ID...');