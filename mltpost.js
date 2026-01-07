require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

// Проверка конфигурации
if (!process.env.TELEGRAM_TOKEN) {
    console.error('❌ Требуется TELEGRAM_TOKEN');
    process.exit(1);
}

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;

// Инициализация бота
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: true });
console.log('🤖 Бот запущен для Яндекс.Почты');

// Собираем Яндекс аккаунты из .env
const yandexAccounts = [];

// Формат в .env для каждого пользователя:
// YANDEX_USER_1=почта1@yandex.ru
// YANDEX_PASS_1=пароль1
// YANDEX_CHAT_ID_1=chat_id1
// YANDEX_USER_2=почта2@yandex.ru
// YANDEX_PASS_2=пароль2
// YANDEX_CHAT_ID_2=chat_id2

let accountIndex = 1;
while (true) {
    const userKey = `YANDEX_USER_${accountIndex}`;
    const passKey = `YANDEX_PASS_${accountIndex}`;
    const chatKey = `YANDEX_CHAT_ID_${accountIndex}`;
    
    const email = process.env[userKey];
    const password = process.env[passKey];
    const chatId = process.env[chatKey];
    
    // Если нет хотя бы одного из обязательных полей - останавливаемся
    if (!email || !password || !chatId) {
        if (accountIndex === 1) {
            console.error('❌ Нет настроенных Яндекс аккаунтов');
            console.error('Добавьте в .env хотя бы один аккаунт:');
            console.error('YANDEX_USER_1=почта@yandex.ru');
            console.error('YANDEX_PASS_1=пароль_приложения');
            console.error('YANDEX_CHAT_ID_1=id_чата');
            process.exit(1);
        }
        break;
    }
    
    const account = {
        index: accountIndex,
        email: email,
        password: password,
        chatId: chatId,
        lastUid: 0,
        imap: null,
        connected: false,
        userInfo: `Пользователь ${accountIndex}`,
        lastCheck: null
    };
    
    yandexAccounts.push(account);
    console.log(`📧 Яндекс #${accountIndex}: ${email} → чат ${chatId}`);
    
    accountIndex++;
}

console.log(`\n✅ Найдено ${yandexAccounts.length} Яндекс аккаунтов\n`);

// Функция для извлечения текста
function getEmailText(email) {
    if (email.text) return email.text;
    
    if (email.html) {
        return email.html
            .replace(/<[^>]*>/g, ' ')
            .replace(/\s+/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/&[a-z]+;/g, ' ')
            .trim();
    }
    
    if (email.subject) return `Тема: ${email.subject}`;
    
    return 'Письмо без текста';
}

// Отправка письма в Telegram
async function sendToTelegram(email, account) {
    try {
        const { from, subject, date } = email;
        let text = getEmailText(email);
        
        if (!text || text.trim().length < 3) {
            if (email.html && email.html.length > 50) {
                text = email.html.substring(0, 500)
                    .replace(/<[^>]*>/g, ' ')
                    .trim();
            } else {
                console.log(`⏭️  Пропущено (аккаунт #${account.index}): нет текста`);
                return;
            }
        }
        
        // Формируем сообщение
        let message = `📧 Яндекс.Почта\n\n`;
        
        // Красиво форматируем отправителя
        const fromText = from?.text || from?.value?.[0]?.address || 'Неизвестный отправитель';
        const fromName = fromText.includes('@') ? fromText.split('@')[0] : fromText;
        message += `👤 От: ${fromName}\n`;
        
        if (subject) {
            message += `📌 Тема: ${subject}\n`;
        }
        
        message += `🕐 ${new Date(date).toLocaleString('ru-RU')}\n\n`;
        
        // Очищаем и ограничиваем текст
        let cleanText = text
            .replace(/\r\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        
        const maxLength = 3500;
        if (cleanText.length > maxLength) {
            cleanText = cleanText.substring(0, maxLength) + '\n\n[...]';
        }
        
        message += cleanText;
        
        // Добавляем информацию о вложениях
        if (email.attachments?.length > 0) {
            const attachList = email.attachments
                .slice(0, 3)
                .map(a => `▫️ ${a.filename || 'файл'}`)
                .join('\n');
            message += `\n\n📎 Вложения:\n${attachList}`;
            if (email.attachments.length > 3) {
                message += `\n... и ещё ${email.attachments.length - 3}`;
            }
        }
        
        // Отправляем
        await bot.sendMessage(account.chatId, message);
        console.log(`✅ Отправлено (аккаунт #${account.index} -> чат ${account.chatId})`);
        
    } catch (error) {
        console.error(`❌ Ошибка отправки (аккаунт #${account.index}):`, error.message);
    }
}

// Проверка новых писем для аккаунта
function checkAccountEmails(account) {
    if (!account.connected || !account.imap) {
        console.log(`⏸️  Аккаунт #${account.index} не подключен`);
        return;
    }
    
    account.lastCheck = new Date();
    
    account.imap.openBox('INBOX', false, (err, box) => {
        if (err) {
            console.error(`❌ Ошибка INBOX (аккаунт #${account.index}):`, err.message);
            return;
        }
        
        const totalMessages = box.messages.total;
        const startUid = account.lastUid + 1;
        
        if (startUid > totalMessages) {
            return; // Нет новых писем
        }
        
        console.log(`🔍 Аккаунт #${account.index}: новые письма ${startUid}-${totalMessages}`);
        
        const fetch = account.imap.seq.fetch(`${startUid}:${totalMessages}`, {
            bodies: [''],
            struct: true
        });
        
        let processed = 0;
        
        fetch.on('message', (msg, seqno) => {
            let buffer = '';
            
            msg.on('body', (stream) => {
                stream.on('data', (chunk) => buffer += chunk.toString('utf8'));
                
                stream.once('end', async () => {
                    try {
                        const parsed = await simpleParser(buffer);
                        await sendToTelegram(parsed, account);
                        account.lastUid = seqno;
                        processed++;
                    } catch (error) {
                        console.error(`❌ Ошибка парсинга (аккаунт #${account.index}):`, error.message);
                    }
                });
            });
        });
        
        fetch.once('error', (err) => {
            console.error(`❌ Ошибка fetch (аккаунт #${account.index}):`, err.message);
        });
        
        fetch.once('end', () => {
            if (processed > 0) {
                console.log(`✅ Аккаунт #${account.index}: обработано ${processed} писем`);
            }
        });
    });
}

// Подключение Яндекс аккаунта
function connectYandexAccount(account) {
    console.log(`🔗 Подключение аккаунта #${account.index} (${account.email})...`);
    
    const imap = new Imap({
        user: account.email,
        password: account.password,
        host: 'imap.yandex.ru',
        port: 993,
        tls: true,
        tlsOptions: {
            rejectUnauthorized: false,
            servername: 'imap.yandex.ru'
        },
        connTimeout: 15000,
        authTimeout: 10000
    });
    
    account.imap = imap;
    
    imap.once('ready', () => {
        console.log(`✅ Аккаунт #${account.index} подключен`);
        account.connected = true;
        
        // Получаем начальное состояние
        imap.openBox('INBOX', false, (err, box) => {
            if (!err && box) {
                account.lastUid = box.messages.total;
                console.log(`   📬 Писем в ящике: ${account.lastUid}`);
            }
        });
        
        // Слушаем новые письма
        imap.on('mail', (numNew) => {
            console.log(`📨 Аккаунт #${account.index}: ${numNew} новое(ых) письмо(а)`);
            setTimeout(() => checkAccountEmails(account), 2000);
        });
    });
    
    imap.on('error', (err) => {
        console.error(`❌ Ошибка аккаунта #${account.index}:`, err.message);
        account.connected = false;
        
        // Переподключение через минуту
        setTimeout(() => {
            console.log(`🔄 Переподключение аккаунта #${account.index}...`);
            if (account.imap) account.imap.end();
            connectYandexAccount(account);
        }, 60000);
    });
    
    imap.on('end', () => {
        console.log(`🔌 Аккаунт #${account.index} отключен`);
        account.connected = false;
    });
    
    imap.connect();
}

// Подключаем все Яндекс аккаунты
yandexAccounts.forEach(account => {
    connectYandexAccount(account);
    
    // Первая проверка через 3 секунды
    setTimeout(() => {
        if (account.connected) {
            checkAccountEmails(account);
        }
    }, 3000);
});

// Команды бота
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id.toString();
    
    // Находим аккаунт, привязанный к этому чату
    const userAccount = yandexAccounts.find(acc => acc.chatId === chatId);
    
    if (!userAccount) {
        bot.sendMessage(chatId, 
            '👋 Привет! Этот чат не привязан к Яндекс.Почте.\n\n' +
            'Для подключения добавьте в настройки:\n' +
            `YANDEX_CHAT_ID_N=${chatId}\n\n` +
            'Где N - номер вашего аккаунта.'
        );
        return;
    }
    
    const status = userAccount.connected ? '✅ Подключен' : '❌ Ошибка подключения';
    const lastCheck = userAccount.lastCheck 
        ? `\nПоследняя проверка: ${userAccount.lastCheck.toLocaleTimeString('ru-RU')}`
        : '';
    
    bot.sendMessage(chatId, 
        `📧 Ваша Яндекс.Почта\n\n` +
        `Аккаунт #${userAccount.index}\n` +
        `Почта: ${userAccount.email}\n` +
        `Статус: ${status}\n` +
        `Обработано писем: ${userAccount.lastUid}` +
        lastCheck +
        `\n\nНовые письма приходят автоматически.`
    );
});

bot.onText(/\/check/, (msg) => {
    const chatId = msg.chat.id.toString();
    const userAccount = yandexAccounts.find(acc => acc.chatId === chatId);
    
    if (!userAccount) {
        bot.sendMessage(chatId, '❌ У этого чата нет привязанной Яндекс.Почты');
        return;
    }
    
    bot.sendMessage(chatId, '🔍 Проверяю почту...');
    
    if (userAccount.connected) {
        checkAccountEmails(userAccount);
        setTimeout(() => {
            bot.sendMessage(chatId, '✅ Проверка завершена');
        }, 2000);
    } else {
        bot.sendMessage(chatId, '❌ Аккаунт не подключен. Пытаюсь переподключиться...');
        if (userAccount.imap) userAccount.imap.end();
        setTimeout(() => connectYandexAccount(userAccount), 1000);
    }
});

bot.onText(/\/status/, (msg) => {
    const chatId = msg.chat.id.toString();
    const userAccount = yandexAccounts.find(acc => acc.chatId === chatId);
    
    if (!userAccount) {
        bot.sendMessage(chatId, '❌ У этого чата нет привязанного аккаунта');
        return;
    }
    
    let detailedInfo = `📊 Детальная информация:\n\n`;
    detailedInfo += `Аккаунт #${userAccount.index}\n`;
    detailedInfo += `Почта: ${userAccount.email}\n`;
    detailedInfo += `Чат ID: ${userAccount.chatId}\n`;
    detailedInfo += `Статус: ${userAccount.connected ? '✅ ONLINE' : '❌ OFFLINE'}\n`;
    detailedInfo += `Последний UID: ${userAccount.lastUid}\n`;
    
    if (userAccount.lastCheck) {
        const timeDiff = Math.floor((new Date() - userAccount.lastCheck) / 60000);
        detailedInfo += `Последняя проверка: ${timeDiff} мин. назад\n`;
    }
    
    bot.sendMessage(chatId, detailedInfo);
});

// Админ команда (только для определенных chat id)
const ADMIN_CHAT_IDS = process.env.ADMIN_CHAT_IDS?.split(',').map(id => id.trim()) || [];

bot.onText(/\/admin_stats/, (msg) => {
    if (!ADMIN_CHAT_IDS.includes(msg.chat.id.toString())) {
        bot.sendMessage(msg.chat.id, '⛔ Доступ запрещен');
        return;
    }
    
    let stats = `👑 Админ-панель\n\n`;
    stats += `Всего аккаунтов: ${yandexAccounts.length}\n\n`;
    
    yandexAccounts.forEach(acc => {
        const status = acc.connected ? '✅' : '❌';
        stats += `${status} Аккаунт #${acc.index}\n`;
        stats += `   📧 ${acc.email}\n`;
        stats += `   💬 Чат: ${acc.chatId}\n`;
        stats += `   📬 Писем: ${acc.lastUid}\n\n`;
    });
    
    bot.sendMessage(msg.chat.id, stats);
});

bot.onText(/\/admin_restart/, (msg) => {
    if (!ADMIN_CHAT_IDS.includes(msg.chat.id.toString())) {
        bot.sendMessage(msg.chat.id, '⛔ Доступ запрещен');
        return;
    }
    
    bot.sendMessage(msg.chat.id, '🔄 Перезапускаю все аккаунты...');
    
    yandexAccounts.forEach(account => {
        if (account.imap) {
            account.imap.end();
        }
        setTimeout(() => connectYandexAccount(account), 1000);
    });
    
    setTimeout(() => {
        bot.sendMessage(msg.chat.id, '✅ Все аккаунты перезапущены');
    }, 3000);
});

// Периодическая проверка всех аккаунтов
setInterval(() => {
    console.log('\n🔄 Плановый обход всех аккаунтов...');
    yandexAccounts.forEach(account => {
        if (account.connected) {
            checkAccountEmails(account);
        }
    });
}, 300000); // Каждые 5 минут

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('\n🔴 Завершение работы бота...');
    
    yandexAccounts.forEach(account => {
        if (account.imap) {
            console.log(`   Отключаю аккаунт #${account.index}...`);
            account.imap.end();
        }
    });
    
    setTimeout(() => {
        console.log('✅ Все подключения закрыты');
        process.exit(0);
    }, 2000);
});

process.on('SIGTERM', () => {
    console.log('\n🔴 Получен SIGTERM...');
    process.emit('SIGINT');
});