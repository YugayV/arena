/**
 * Двуязычие сайта.
 *
 * Автор: Vitaliy Yugay · vamp.09.94@gmail.com · https://github.com/YugayV
 *
 * В макете есть переключатель eng, поэтому язык здесь настоящий, а не
 * подпись. Английские строки взяты из макета дословно — это его исходный
 * текст; русские написаны по нему.
 *
 * Покрыта статическая разметка страницы: всё, что помечено data-i18n.
 * Сообщения, которые приходят с сервера (ошибки движка, статусы сделок),
 * остаются русскими — переводить их надо на сервере, иначе перевод
 * разъедется с тем, что записано в базе.
 */

const I18N = {
  ru: {
    'nav.home': 'Площадка',
    'nav.about': 'О нас',
    'nav.products': 'Продукты',
    'nav.academy': 'Академия',
    'nav.rules': 'Правила',
    'nav.arena': 'Торговля',
    'nav.board': 'Таблица',
    'nav.profile': 'Профиль',
    'nav.login': 'Войти',

    'brand.sub': 'SM PRO',

    /* ------------------------------------------------------------ герой */
    'hero.kicker': 'KHUSA · с 2026 года',
    'hero.title': 'Турнир по торговле<br>от структуры рынка',
    'hero.lead': 'Бумажный счёт, общие для всех котировки и единственное правило зачёта: сделка засчитывается так, как её исполнил бы рынок, а не так, как хотелось участнику.',
    'hero.cta': 'Участвовать бесплатно',
    'hero.cta2': 'Смотреть таблицу',
    'hero.k1': 'Инструментов',
    'hero.k2': 'Участников',
    'hero.k3': 'Стартовый счёт',
    'hero.k4': 'До конца',
    'hero.results': 'Последние результаты',
    'hero.empty': 'Пока никто не участвует — станьте первым.',

    /* --------------------------------------------------------- почему мы */
    'why.label': 'Почему выбирают',
    'why.title': 'Выбор трейдеров',
    'why.1.h': 'Быстрая поддержка',
    'why.1.p': 'Ответы на вопросы и помощь команды тогда, когда это нужно.',
    'why.2.h': 'Профессиональные инструменты',
    'why.2.p': 'Современные средства анализа рынка, повышающие эффективность торговли.',
    'why.3.h': 'Постоянное развитие',
    'why.3.p': 'Площадка развивается: новые функции и инструменты появляются регулярно.',
    'why.4.h': 'Всё в одном месте',
    'why.4.p': 'Обучение, анализ рынка, инструменты, турниры и сообщество — на одной платформе.',

    /* ---------------------------------------------------------- участие */
    'join.label': 'Участие бесплатное',
    'join.title': 'Покажите,<br>на что способны',
    'join.p': 'Регистрация, бумажный счёт и торговля по общим котировкам. Результат считается по нашему ряду свечей — тому же, что вы видите на графике площадки.',
    'join.cta': 'Принять участие',
    'join.cta2': 'Открыть торговлю',
    'join.card': 'Текущий турнир',

    /* --------------------------------------------------------- продукты */
    'prod.label': 'Продукты',
    'prod.title': 'Инструменты',
    'prod.lead': 'Один подход. Три инструмента. Структурный взгляд на рынок, автоматизация торговли и понятные правила.',
    'prod.full': 'Полный набор инструментов для профессиональной торговли: индикатор, торговый робот и подробное руководство.',
    'prod.develop': 'Выстроите структурный подход к рынку, автоматизируете торговлю и глубже разберётесь в системе KHUSA SM PRO.',
    'prod.buy': 'Купить продукты KHUSA SM PRO',
    'prod.ind.label': 'Индикатор',
    'prod.ind.h': 'KHUSA SM PRO — индикатор',
    'prod.ind.p': 'Профессиональный торговый индикатор для анализа структуры рынка и определения ключевых движений. Помогает видеть структуру яснее и системнее.',
    'prod.bot.label': 'Робот',
    'prod.bot.h': 'KHUSA SM PRO — торговый робот',
    'prod.bot.p': 'Автоматический торговый робот, работающий по той же логике, что и KHUSA SM PRO. Помогает автоматизировать процесс и выполнять заданные правила без эмоционального вмешательства.',
    'prod.man.label': 'Руководство',
    'prod.man.h': 'KHUSA SM PRO — руководство',
    'prod.man.p': 'Подробное руководство по системе KHUSA SM PRO. Объясняет логику системы, ключевые элементы и правила применения индикатора и торгового подхода.',

    /* --------------------------------------------------------- академия */
    'acad.label': 'Академия',
    'acad.title': 'Обучение',
    'acad.1.h': 'Обучение',
    'acad.1.p': 'Доступ к обучающим материалам, книгам и практическим знаниям, которые помогут лучше понимать рынок и развивать навыки.',
    'acad.2.h': 'Анализ и инструменты',
    'acad.2.p': 'Анализируйте рынок и используйте профессиональные индикаторы, торговые инструменты и роботов для более эффективной торговли.',
    'acad.3.h': 'Турниры и сообщество',
    'acad.3.p': 'Участвуйте в турнирах и конкурсах, соревнуйтесь с другими трейдерами и общайтесь с единомышленниками в нашем сообществе.',

    /* ---------------------------------------------------------- правила */
    'rules.label': 'Правила турнира',
    'rules.title': 'Как считается',
    'rules.warn.tag': 'Внимание',
    'rules.warn.p': 'Перед участием обязательно ознакомьтесь с правилами и условиями. Участие в турнире означает согласие с установленными правилами. Прочитайте их заранее, чтобы понимать все условия участия.',
    'rules.warn.cta': 'Ознакомиться',
    'rules.1.n': 'Правило 01',
    'rules.1.h': 'Нельзя играть в прошлое',
    'rules.1.p': 'Отложенный ордер исполняется только свечами строго позже размещения. Поставить лимитку по уже известному хаю не получится.',
    'rules.2.n': 'Правило 02',
    'rules.2.h': 'Отставший поток закрывает торговлю',
    'rules.2.p': 'Если наш ряд котировок отстал от рынка, приём ордеров прекращается сразу для всех — иначе вход по устаревшей цене был бы безрисковым.',
    'rules.3.n': 'Правило 03',
    'rules.3.h': 'Стоп важнее цели',
    'rules.3.p': 'Если внутри одной свечи достижимы и стоп, и цель, засчитывается стоп: порядок тиков внутри свечи неизвестен.',
    'rules.more': 'Дополнительно: стоп обязателен, объём считается из процента риска, спред вычитается на входе и на выходе, действуют пределы на число открытых сделок и висящих ордеров.',
    'rules.disclaimer': 'Турнир учебный. Реальные деньги не участвуют, инвестиционных рекомендаций мы не даём.',

    /* ------------------------------------------------------------ о нас */
    'about.label': 'О нас',
    'about.title': 'Кто мы',
    'about.who.h': 'Кто мы',
    'about.who.p': 'KHUSA SM PRO — бренд торговых технологий, сосредоточенный на разработке инструментов для финансовых рынков. Мы соединяем концепции Smart Money, анализ структуры рынка и современные торговые технологии, создавая практичные решения.',
    'about.what.h': 'Что мы делаем',
    'about.what.p': 'Разрабатываем профессиональные торговые индикаторы, аналитические инструменты и обучающие продукты, помогающие трейдерам работать системно.',
    'about.mission.h': 'Наша задача',
    'about.mission.p': 'Наша задача проста — сделать профессиональный анализ рынка доступнее, структурнее и понятнее.',
    'about.team.label': 'Команда',
    'about.team.title': 'Команда',
    'about.team.lead': 'Небольшая команда, которая делает инструменты и ведёт площадку.',

    /* ---------------------------------------------------------- торговля */
    'arena.chartNote': 'Это ряд котировок площадки — именно по нему исполняются ордера.',
    'arena.myTrades': 'Мои сделки',
    'arena.account': 'Счёт',
    'arena.balance': 'Баланс',
    'arena.equity': 'Средства',
    'arena.trades': 'Сделок',
    'arena.dd': 'Просадка',
    'arena.newTrade': 'Новая сделка',
    'arena.side': 'Направление',
    'arena.buy': 'Покупка',
    'arena.sell': 'Продажа',
    'arena.kind': 'Тип',
    'arena.market': 'По рынку',
    'arena.limit': 'Лимитный',
    'arena.limitPrice': 'Цена лимитки',
    'arena.sl': 'Стоп — обязателен',
    'arena.tp': 'Цель',
    'arena.risk': 'Риск на сделку, % депозита',
    'arena.preview': 'Заполните стоп, чтобы увидеть объём и R:R.',
    'arena.send': 'Отправить',
    'arena.hint': 'Подсказка',
    'arena.hintRules': 'Разбор по правилам',
    'arena.hintModel': 'Спросить модель',

    /* ----------------------------------------------------------- таблица */
    'board.label': 'Результаты',
    'board.title': 'Таблица',
    'board.place': '#',
    'board.player': 'Участник',
    'board.equity': 'Средства',
    'board.return': 'Доход',
    'board.dd': 'Просадка',
    'board.trades': 'Сделок',

    /* ----------------------------------------------------------- профиль */
    'profile.title': 'Профиль',
    'profile.history': 'История сделок',
    'auth.login': 'Вход',
    'auth.register': 'Регистрация',
    'auth.email': 'Почта',
    'auth.loginField': 'Почта или имя',
    'auth.nickField': 'Имя участника',
    'auth.pass': 'Пароль',
    'auth.passHint': 'минимум 8 символов',
    'auth.submitLogin': 'Войти',
    'auth.submitReg': 'Зарегистрироваться',
    'auth.toReg': 'Я новый участник',
    'auth.toLogin': 'У меня уже есть аккаунт',
    'th.opened': 'Открыта',
    'th.symbol': 'Инструмент',
    'th.side': 'Сторона',
    'th.entry': 'Вход',
    'th.exit': 'Выход',
    'th.reason': 'Причина',
    'th.pnl': 'Результат',
    'th.r': 'R',

    /* ------------------------------------------------------------- футер */
    'foot.tagline': 'Учебная турнирная площадка. Реальные деньги не участвуют, инвестиционных рекомендаций мы не даём.',
    'foot.partner': 'Надёжное партнёрство',
    'foot.contacts': 'Контакты',
    'foot.info': 'Информация',
    'foot.info.about': 'О нас',
    'foot.info.support': 'Поддержка',
    'foot.info.partners': 'Партнёрство',
    'foot.legal': 'Правовое',
    'foot.legal.privacy': 'Политика конфиденциальности',
    'foot.legal.terms': 'Условия использования',
    'foot.legal.offer': 'Публичная оферта',
    'foot.sections': 'Разделы',
    'foot.dashboard': 'Дашборд разметки',
    'foot.rights': '© 2026 KHUSA. Все права защищены.',
    'foot.note': 'Учебный турнир · без реальных денег',
  },

  /* ===================================================================== */
  en: {
    'nav.home': 'Platform',
    'nav.about': 'About us',
    'nav.products': 'Products',
    'nav.academy': 'Academy',
    'nav.rules': 'Rules',
    'nav.arena': 'Trading',
    'nav.board': 'Leaderboard',
    'nav.profile': 'Profile',
    'nav.login': 'Log in',

    'brand.sub': 'SM PRO',

    'hero.kicker': 'KHUSA · since 2026',
    'hero.title': 'Tournament in trading<br>from market structure',
    'hero.lead': 'A paper account, quotes shared by everyone and a single scoring rule: a trade counts the way the market would have filled it, not the way you wanted it filled.',
    'hero.cta': 'Participate for free',
    'hero.cta2': 'View leaderboard',
    'hero.k1': 'Instruments',
    'hero.k2': 'Participants',
    'hero.k3': 'Starting balance',
    'hero.k4': 'Time left',
    'hero.results': 'Latest results',
    'hero.empty': 'Nobody is competing yet — be the first.',

    'why.label': "Why we're the people's choice",
    'why.title': "People's choice",
    'why.1.h': 'Fast support',
    'why.1.p': 'Get fast answers to your questions and help from our team when you need it.',
    'why.2.h': 'Professional tools',
    'why.2.p': 'Use modern tools and solutions designed to analyze the market and improve the efficiency of your trading.',
    'why.3.h': 'Continuous development',
    'why.3.p': "We're constantly developing the platform, adding new features, tools, and functions to give you even more opportunities for growth.",
    'why.4.h': 'All in one place',
    'why.4.p': 'Education, market analysis, tools, trading solutions, tournaments and community — all gathered on one platform.',

    'join.label': 'Participate for free',
    'join.title': 'Show what<br>you are made of',
    'join.p': 'Registration, a paper account and trading on shared quotes. Your result is scored on our own candle series — the same one you see on the platform chart.',
    'join.cta': 'Take part',
    'join.cta2': 'Open trading',
    'join.card': 'Current tournament',

    'prod.label': 'Products',
    'prod.title': 'Tools',
    'prod.lead': 'One approach. Three tools. More possibilities.',
    'prod.full': 'Get a complete set of tools for professional trading: an indicator, a trading robot, and detailed instructions.',
    'prod.develop': 'Develop a structured approach to the market, automate your trading, and delve deeper into the KHUSA SM PRO system.',
    'prod.buy': 'Buy KHUSA SM PRO products',
    'prod.ind.label': 'Indicator',
    'prod.ind.h': 'KHUSA SM PRO — indicator',
    'prod.ind.p': 'A professional trading indicator for analyzing market structure and identifying key market movements. It helps traders see the structure more clearly and systematically.',
    'prod.bot.label': 'Robot',
    'prod.bot.h': 'KHUSA SM PRO — trading robot',
    'prod.bot.p': 'An automated trading robot designed to operate using the same logic as KHUSA SM PRO. It helps automate the trading process and execute preset rules without emotional intervention.',
    'prod.man.label': 'Manual',
    'prod.man.h': 'KHUSA SM PRO — manual',
    'prod.man.p': "A detailed guide to the KHUSA SM PRO system. Explains the system's logic, key elements, and rules for using the indicator and trading approach.",

    'acad.label': 'Academy',
    'acad.title': 'Education',
    'acad.1.h': 'Education',
    'acad.1.p': 'Gain access to training materials, books, and practical knowledge to help you better understand the market and develop your skills.',
    'acad.2.h': 'Analysis and tools',
    'acad.2.p': 'Analyze the market and use professional indicators, trading tools, and robots for more efficient trading.',
    'acad.3.h': 'Tournaments and community',
    'acad.3.p': 'Participate in tournaments and contests, compete with other traders, and connect with like-minded people in our community.',

    'rules.label': 'Tournament rules',
    'rules.title': 'How scoring works',
    'rules.warn.tag': 'Warning',
    'rules.warn.p': 'Before participating in the tournament, please be sure to read the rules and conditions. Participation signifies your agreement to the established rules. Please read them in advance to ensure you understand all the conditions for participation.',
    'rules.warn.cta': 'Get acquainted',
    'rules.1.n': 'Rule 01',
    'rules.1.h': 'You cannot play the past',
    'rules.1.p': 'A pending order is only filled by candles strictly later than when it was placed. Placing a limit at an already known high will not work.',
    'rules.2.n': 'Rule 02',
    'rules.2.h': 'A lagging feed closes trading',
    'rules.2.p': 'If our candle series falls behind the market, order intake stops for everyone at once — otherwise entering at a stale price would be risk-free.',
    'rules.3.n': 'Rule 03',
    'rules.3.h': 'Stop beats target',
    'rules.3.p': 'If both the stop and the target are reachable inside one candle, the stop counts: the order of ticks inside a candle is unknown.',
    'rules.more': 'Additionally: a stop is mandatory, position size is derived from risk percentage, spread is charged on entry and exit, and limits apply to the number of open trades and pending orders.',
    'rules.disclaimer': 'This is an educational tournament. No real money is involved and we give no investment advice.',

    'about.label': 'About us',
    'about.title': 'Who we are',
    'about.who.h': 'Who we are',
    'about.who.p': 'KHUSA SM PRO is a professional trading technology brand focused on developing innovative tools for financial markets. We combine Smart Money Concepts, market structure analysis and advanced trading technology to create practical solutions.',
    'about.what.h': 'What we do',
    'about.what.p': 'We develop professional trading indicators, analytical tools and educational products designed to help traders work systematically.',
    'about.mission.h': 'Our mission',
    'about.mission.p': 'Our mission is simple — to make professional market analysis more accessible, structured and understandable.',
    'about.team.label': 'Team',
    'about.team.title': 'Team',
    'about.team.lead': 'A small team that builds the tools and runs the platform.',

    'arena.chartNote': 'This is the platform quote series — orders are filled on exactly this data.',
    'arena.myTrades': 'My trades',
    'arena.account': 'Account',
    'arena.balance': 'Balance',
    'arena.equity': 'Equity',
    'arena.trades': 'Trades',
    'arena.dd': 'Drawdown',
    'arena.newTrade': 'New trade',
    'arena.side': 'Direction',
    'arena.buy': 'Buy',
    'arena.sell': 'Sell',
    'arena.kind': 'Type',
    'arena.market': 'Market',
    'arena.limit': 'Limit',
    'arena.limitPrice': 'Limit price',
    'arena.sl': 'Stop — required',
    'arena.tp': 'Target',
    'arena.risk': 'Risk per trade, % of balance',
    'arena.preview': 'Fill in the stop to see size and R:R.',
    'arena.send': 'Submit',
    'arena.hint': 'Hint',
    'arena.hintRules': 'Rules-based analysis',
    'arena.hintModel': 'Ask the model',

    'board.label': 'Results',
    'board.title': 'Leaderboard',
    'board.place': '#',
    'board.player': 'Participant',
    'board.equity': 'Equity',
    'board.return': 'Return',
    'board.dd': 'Drawdown',
    'board.trades': 'Trades',

    'profile.title': 'Profile',
    'profile.history': 'Trade history',
    'auth.login': 'Log in',
    'auth.register': 'Sign up',
    'auth.email': 'Email',
    'auth.loginField': 'Email or name',
    'auth.nickField': 'Display name',
    'auth.pass': 'Password',
    'auth.passHint': 'at least 8 characters',
    'auth.submitLogin': 'Log in',
    'auth.submitReg': 'Sign up',
    'auth.toReg': "I'm new here",
    'auth.toLogin': 'I already have an account',
    'th.opened': 'Opened',
    'th.symbol': 'Instrument',
    'th.side': 'Side',
    'th.entry': 'Entry',
    'th.exit': 'Exit',
    'th.reason': 'Reason',
    'th.pnl': 'Result',
    'th.r': 'R',

    'foot.tagline': 'An educational tournament platform. No real money is involved and we give no investment advice.',
    'foot.partner': 'Reliable partnership',
    'foot.contacts': 'Contacts',
    'foot.info': 'Information',
    'foot.info.about': 'About us',
    'foot.info.support': 'Support',
    'foot.info.partners': 'Partnerships',
    'foot.legal': 'Legal',
    'foot.legal.privacy': 'Privacy policy',
    'foot.legal.terms': 'Terms of use',
    'foot.legal.offer': 'Public offer',
    'foot.sections': 'Sections',
    'foot.dashboard': 'Markup dashboard',
    'foot.rights': '© 2026 KHUSA. All rights reserved.',
    'foot.note': 'Educational tournament · no real money',
  },
};

/** Строка по ключу. Неизвестный ключ возвращается как есть — так пропущенный
 *  перевод виден сразу, а не превращается в пустое место на странице. */
function t(key, lang) {
  const dict = I18N[lang] || I18N.ru;
  return dict[key] !== undefined ? dict[key] : (I18N.ru[key] !== undefined ? I18N.ru[key] : key);
}

/** Применение словаря ко всей размеченной статике. */
function applyI18n(lang) {
  document.documentElement.lang = lang;

  document.querySelectorAll('[data-i18n]').forEach((el) => {
    el.innerHTML = t(el.dataset.i18n, lang);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    el.placeholder = t(el.dataset.i18nPh, lang);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.title = t(el.dataset.i18nTitle, lang);
  });
}

window.I18N = I18N;
window.t = t;
window.applyI18n = applyI18n;
