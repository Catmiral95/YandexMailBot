require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

// Проверка конфигурации
const required = ['TELEGRAM_TOKEN', 'TELEGRAM_CHAT_ID', 'YANDEX_USER', 'YANDEX_PASS'];
for (const key of required) {
    if (!process.env[key]) {
        console.error(`❌ Требуется: ${key}`);
        process.exit(1);
    }
}

const {
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    YANDEX_USER,
    YANDEX_PASS
} = process.env;

// Инициализация бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Бот запущен');

// Настройка IMAP для Яндекс
const imap = new Imap({
    user: YANDEX_USER,
    password: YANDEX_PASS,
    host: 'imap.yandex.ru',
    port: 993,
    tls: true,
    tlsOptions: {
        rejectUnauthorized: false,
        servername: 'imap.yandex.ru'
    }
});

let lastUid = 0;
let imapConnected = false;

// Функция для извлечения текста из письма
function getEmailText(email) {
    let text = '';
    
    // 1. Пробуем получить обычный текст
    if (email.text) {
        text = email.text;
    }
    // 2. Если нет текста, пробуем извлечь из HTML
    else if (email.html) {
        // Упрощенное извлечение текста из HTML
        text = email.html
            .replace(/<[^>]*>/g, ' ') // Удаляем HTML теги
            .replace(/\s+/g, ' ')     // Убираем лишние пробелы
            .replace(/&nbsp;/g, ' ')  // Заменяем неразрывные пробелы
            .replace(/&lt;/g, '<')    // Восстанавливаем символы
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .replace(/&quot;/g, '"')
            .trim();
    }
    // 3. Если есть subject, используем его как текст
    else if (email.subject) {
        text = `Тема: ${email.subject}`;
    }
    // 4. Если вообще ничего нет
    else {
        text = 'Письмо без текстового содержимого';
    }
    
    return text;
}

// Функция отправки письма в Telegram
function sendToTelegram(email) {
    try {
        const { from, subject, date } = email;
        let text = getEmailText(email);
        
        // Если текст слишком короткий и есть HTML, пробуем извлечь больше
        if (text.length < 50 && email.html) {
            text = email.html.substring(0, 1000)
                .replace(/<[^>]*>/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();
        }
        
        // Если все еще нет текста
        if (!text || text.trim().length === 0) {
            console.log('Пропущено: не удалось извлечь текст');
            return;
        }
        
        let message = '📧 Яндекс.Почта\n\n';
        message += `От: ${from?.text || from?.value?.[0]?.address || 'Неизвестно'}\n`;
        
        if (subject) {
            message += `Тема: ${subject}\n`;
        }
        
        message += `Время: ${new Date(date).toLocaleString('ru-RU')}\n\n`;
        
        // Ограничиваем длину
        const maxLength = 3500;
        let emailText = text.replace(/\r\n/g, '\n');
        
        if (emailText.length > maxLength) {
            emailText = emailText.substring(0, maxLength) + '\n\n[... обрезано ...]';
        }
        
        message += emailText;
        
        // Добавляем информацию о типе письма
        if (email.attachments && email.attachments.length > 0) {
            message += `\n\n📎 Вложений: ${email.attachments.length}`;
        }
        
        bot.sendMessage(TELEGRAM_CHAT_ID, message)
            .then(() => console.log('✅ Отправлено в Telegram'))
            .catch(err => console.error('❌ Ошибка Telegram:', err.message));
            
    } catch (error) {
        console.error('Ошибка обработки письма:', error.message);
        console.error('Письмо data:', JSON.stringify({
            subject: email.subject,
            hasText: !!email.text,
            hasHtml: !!email.html,
            attachments: email.attachments?.length || 0
        }, null, 2));
    }
}

// Функция проверки новых писем
function checkNewEmails() {
    if (!imapConnected) {
        console.log('IMAP не подключен');
        return;
    }
    
    imap.openBox('INBOX', false, (err, box) => {
        if (err) {
            console.error('❌ Ошибка INBOX:', err.message);
            return;
        }
        
        const start = lastUid + 1;
        const end = box.messages.total;
        
        if (start > end) {
            console.log('Нет новых писем');
            return;
        }
        
        console.log(`🔍 Проверка писем ${start}-${end}`);
        
        // Запрашиваем полные данные письма
        const fetch = imap.seq.fetch(`${start}:${end}`, {
            bodies: [''],
            struct: true
        });
        
        fetch.on('message', (msg, seqno) => {
            let buffer = '';
            
            msg.on('body', (stream) => {
                stream.on('data', (chunk) => {
                    buffer += chunk.toString('utf8');
                });
                
                stream.once('end', async () => {
                    try {
                        console.log(`📥 Обработка письма #${seqno}`);
                        const parsed = await simpleParser(buffer);
                        
                        // Отладочная информация
                        console.log(`   Тема: ${parsed.subject || 'нет'}`);
                        console.log(`   От: ${parsed.from?.text || 'нет'}`);
                        console.log(`   Текст: ${parsed.text ? 'есть' : 'нет'}`);
                        console.log(`   HTML: ${parsed.html ? 'есть' : 'нет'}`);
                        console.log(`   Дата: ${parsed.date || 'нет'}`);
                        
                        sendToTelegram(parsed);
                        lastUid = seqno;
                        
                    } catch (error) {
                        console.error(`❌ Ошибка парсинга #${seqno}:`, error.message);
                    }
                });
            });
            
            msg.once('error', (err) => {
                console.error(`❌ Ошибка сообщения #${seqno}:`, err.message);
            });
        });
        
        fetch.once('error', (err) => {
            console.error('❌ Ошибка fetch:', err.message);
        });
        
        fetch.once('end', () => {
            console.log('✅ Проверка завершена');
        });
    });
}

// Подключение к IMAP
imap.once('ready', () => {
    console.log('✅ Подключено к Яндекс.Почте');
    imapConnected = true;
    
    // Получаем начальное состояние
    imap.openBox('INBOX', false, (err, box) => {
        if (!err && box) {
            lastUid = box.messages.total;
            console.log(`📬 Всего писем: ${lastUid}`);
            
            // Начинаем слушать новые письма
            imap.on('mail', () => {
                console.log('📨 Пришло новое письмо');
                setTimeout(() => checkNewEmails(), 1000);
            });
        }
    });
});

imap.on('error', (err) => {
    console.error('❌ Ошибка IMAP:', err.message);
    imapConnected = false;
});

// Команды бота
bot.onText(/\/start/, (msg) => {
    const status = imapConnected ? '✅ Подключено' : '❌ Нет связи';
    bot.sendMessage(msg.chat.id, 
        `📧 Яндекс → Telegram\n\n` +
        `Статус: ${status}\n` +
        `Писем обработано: ${lastUid}\n\n` +
        `Новые письма будут приходить сюда автоматически.`
    );
});

bot.onText(/\/check/, (msg) => {
    bot.sendMessage(msg.chat.id, '🔍 Проверяю почту...');
    checkNewEmails();
});

bot.onText(/\/testmail/, async (msg) => {
    try {
        // Отправляем тестовое письмо самому себе
        const testText = `Тестовое письмо от Telegram бота\n\n` +
                        `Время: ${new Date().toLocaleString('ru-RU')}\n` +
                        `Chat ID: ${msg.chat.id}`;
        
        await bot.sendMessage(TELEGRAM_CHAT_ID, testText);
        await bot.sendMessage(msg.chat.id, '✅ Тестовое сообщение отправлено в чат');
        
    } catch (error) {
        console.error('Ошибка теста:', error);
    }
});

// Запуск проверки при старте
setTimeout(() => {
    if (imapConnected) {
        console.log('🔍 Первоначальная проверка почты...');
        checkNewEmails();
    }
}, 5000);

// Подключаемся
console.log('Подключение к Яндекс.Почте...');
imap.connect();

// Периодическая проверка
setInterval(() => {
    if (imapConnected) {
        console.log('🔄 Периодическая проверка...');
        checkNewEmails();
    }
}, 60000); // Каждую минуту

// Завершение
process.on('SIGINT', () => {
    console.log('\n🔴 Завершение работы...');
    imap.end();
    process.exit(0);
});