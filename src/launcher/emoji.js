import {_, N_} from '../i18n/core.js';

// Emoji and special characters for Thunderstorm, searchable offline by German
// and English names. One entry per line: character | names | category (the
// category's German name in the data; `category` in an entry is its id).
const DATA = `
😀|grinsen lachen fröhlich grinning happy smile|Smileys
😃|lachen freude grosse augen smiley happy|Smileys
😄|lachen strahlen smile laugh|Smileys
😁|grinsen zähne beam grin|Smileys
😆|lachen zugekniffen laughing|Smileys
😅|schweiss erleichtert sweat smile|Smileys
🤣|kugeln vor lachen rofl rolling laughing|Smileys
😂|tränen lachen joy tears laughing|Smileys
🙂|lächeln leicht slightly smiling|Smileys
🙃|kopfüber upside down|Smileys
😉|zwinkern wink|Smileys
😊|erröten lächeln blush smiling|Smileys
😇|heiligenschein unschuldig halo innocent|Smileys
🥰|verliebt herzen smiling hearts love|Smileys
😍|herzaugen verliebt heart eyes|Smileys
🤩|begeistert sterne star struck|Smileys
😘|kuss zuwerfen kiss blowing|Smileys
😋|lecker zunge yum delicious|Smileys
😛|zunge raus tongue|Smileys
😜|zwinkern zunge winking tongue crazy|Smileys
🤪|verrückt zany crazy|Smileys
🤑|geld money mouth|Smileys
🤗|umarmung hug hugging|Smileys
🤭|hand vor mund kichern giggle|Smileys
🤫|psst leise shushing quiet|Smileys
🤔|nachdenken denken thinking hmm|Smileys
🤐|mund zu reissverschluss zipper mouth|Smileys
🤨|skeptisch augenbraue raised eyebrow|Smileys
😐|neutral neutral face|Smileys
😑|ausdruckslos expressionless|Smileys
😶|sprachlos no mouth|Smileys
😏|grinsen schmunzeln smirk|Smileys
😒|genervt unamused|Smileys
🙄|augen rollen eye roll|Smileys
😬|grimasse zähne grimacing awkward|Smileys
😌|erleichtert relieved|Smileys
😔|nachdenklich traurig pensive|Smileys
😪|schläfrig sleepy|Smileys
😴|schlafen müde sleeping zzz|Smileys
😷|maske krank mask sick|Smileys
🤒|fieber krank thermometer sick|Smileys
🤢|übel nauseated|Smileys
🤮|erbrechen vomiting|Smileys
🥵|heiss schwitzen hot|Smileys
🥶|kalt frieren cold freezing|Smileys
🥴|beschwipst woozy|Smileys
😵|schwindlig dizzy|Smileys
🤯|explodierender kopf mind blown|Smileys
🤠|cowboy|Smileys
🥳|party feiern partying celebrate|Smileys
😎|cool sonnenbrille sunglasses|Smileys
🤓|nerd streber brille|Smileys
🧐|monokel monocle|Smileys
😕|verwirrt confused|Smileys
😟|besorgt worried|Smileys
🙁|leicht traurig slightly frowning|Smileys
😮|überrascht mund offen open mouth surprised|Smileys
😲|erstaunt astonished|Smileys
😳|verlegen errötet flushed|Smileys
🥺|bitte flehend pleading puppy eyes|Smileys
😦|entsetzt frowning open mouth|Smileys
😨|ängstlich fearful|Smileys
😰|angstschweiss anxious sweat|Smileys
😥|enttäuscht erleichtert sad relieved|Smileys
😢|weinen träne crying tear|Smileys
😭|heulen schluchzen sobbing loudly crying|Smileys
😱|schreien angst screaming fear|Smileys
😖|verwirrt gequält confounded|Smileys
😣|durchhalten persevering|Smileys
😞|enttäuscht disappointed|Smileys
😓|niedergeschlagen schweiss downcast sweat|Smileys
😩|erschöpft weary|Smileys
😫|müde tired|Smileys
🥱|gähnen yawning|Smileys
😤|schnauben triumph huffing|Smileys
😡|wütend rot pouting angry rage|Smileys
😠|verärgert angry|Smileys
🤬|fluchen symbole cursing|Smileys
😈|teufel grinsen smiling devil|Smileys
💀|totenkopf schädel skull dead|Smileys
💩|kackhaufen poop|Smileys
🤡|clown|Smileys
👻|geist gespenst ghost|Smileys
👽|alien ausserirdisch|Smileys
🤖|roboter robot bot|Smileys
😺|katze lachen grinning cat|Smileys
🙈|affe nichts sehen see no evil monkey|Smileys
🙉|affe nichts hören hear no evil|Smileys
🙊|affe nichts sagen speak no evil|Smileys
👋|winken hallo tschüss waving hand hello bye|Gesten
🤚|hand erhoben raised back of hand|Gesten
✋|hand stopp high five raised hand|Gesten
🖖|vulkanier spock vulcan salute|Gesten
👌|ok perfekt ok hand|Gesten
🤌|italienisch finger pinched fingers|Gesten
✌️|victory frieden peace|Gesten
🤞|daumen drücken glück crossed fingers luck|Gesten
🤟|ich liebe dich love you gesture|Gesten
🤘|rock metal horns|Gesten
🤙|ruf mich an call me shaka|Gesten
👈|zeigen links pointing left|Gesten
👉|zeigen rechts pointing right|Gesten
👆|zeigen oben pointing up|Gesten
👇|zeigen unten pointing down|Gesten
☝️|zeigefinger index pointing up|Gesten
👍|daumen hoch gut ja like thumbs up yes|Gesten
👎|daumen runter schlecht nein dislike thumbs down no|Gesten
✊|faust erhoben raised fist|Gesten
👊|faust schlag fist bump punch|Gesten
👏|klatschen applaus clapping applause|Gesten
🙌|hände hoch feiern raising hands hooray|Gesten
👐|offene hände open hands|Gesten
🤲|handflächen palms up together|Gesten
🤝|handschlag deal handshake agreement|Gesten
🙏|bitte danke beten folded hands please thanks pray|Gesten
✍️|schreiben writing hand|Gesten
💪|muskel stark bizeps flexed biceps strong|Gesten
🧠|gehirn brain|Gesten
👀|augen schauen eyes looking|Gesten
👁️|auge eye|Gesten
🫡|salutieren salute|Gesten
🤷|schulterzucken egal shrug|Gesten
🤦|facepalm kopf hand|Gesten
🙋|hand heben melden raising hand|Gesten
🙅|nein geste no gesture|Gesten
🙆|ok geste ok gesture|Gesten
💁|info person tipping hand|Gesten
👶|baby|Gesten
👨‍💻|entwickler programmierer man technologist developer|Gesten
👩‍💻|entwicklerin programmiererin woman technologist developer|Gesten
❤️|herz rot liebe red heart love|Herzen
🧡|herz orange orange heart|Herzen
💛|herz gelb yellow heart|Herzen
💚|herz grün green heart|Herzen
💙|herz blau blue heart|Herzen
💜|herz lila violett purple heart|Herzen
🖤|herz schwarz black heart|Herzen
🤍|herz weiss white heart|Herzen
🤎|herz braun brown heart|Herzen
💔|gebrochenes herz broken heart|Herzen
❣️|herz ausrufezeichen heart exclamation|Herzen
💕|zwei herzen two hearts|Herzen
💞|kreisende herzen revolving hearts|Herzen
💓|schlagendes herz beating heart|Herzen
💗|wachsendes herz growing heart|Herzen
💖|funkelndes herz sparkling heart|Herzen
💘|herz pfeil amor heart arrow cupid|Herzen
💝|herz schleife geschenk heart ribbon gift|Herzen
❤️‍🔥|herz feuer heart on fire|Herzen
💯|hundert punkte perfekt hundred points|Symbole
💢|wut symbol anger|Symbole
💥|knall explosion collision boom|Symbole
💫|schwindel sterne dizzy|Symbole
💦|tropfen schweiss sweat droplets|Symbole
💨|rennen wind dash|Symbole
💬|sprechblase chat speech balloon|Symbole
💭|gedankenblase thought balloon|Symbole
💤|schlafen zzz|Symbole
✨|funkeln glitzer sparkles|Symbole
⭐|stern star|Symbole
🌟|leuchtender stern glowing star|Symbole
🔥|feuer heiss fire hot lit|Symbole
⚡|blitz strom energie lightning high voltage zap|Symbole
❄️|schneeflocke snowflake|Symbole
☀️|sonne sun sunny|Symbole
🌙|mond halbmond crescent moon|Symbole
☁️|wolke cloud|Symbole
🌧️|regen cloud rain|Symbole
⛈️|gewitter sturm thunderstorm|Symbole
🌈|regenbogen rainbow|Symbole
☔|regenschirm umbrella rain|Symbole
✅|erledigt haken check mark done|Symbole
☑️|kontrollkästchen check box|Symbole
✔️|haken check|Symbole
❌|kreuz falsch nein cross mark wrong|Symbole
❎|kreuz knopf cross button|Symbole
⚠️|warnung achtung warning|Symbole
⛔|verboten kein zutritt no entry|Symbole
🚫|verboten prohibited|Symbole
❓|frage question mark|Symbole
❗|ausrufezeichen exclamation|Symbole
‼️|doppeltes ausrufezeichen double exclamation|Symbole
➕|plus|Symbole
➖|minus|Symbole
➗|geteilt division|Symbole
✖️|mal multiplication|Symbole
♻️|recycling|Symbole
🔴|roter kreis red circle|Symbole
🟢|grüner kreis green circle|Symbole
🔵|blauer kreis blue circle|Symbole
🟡|gelber kreis yellow circle|Symbole
⚪|weisser kreis white circle|Symbole
⚫|schwarzer kreis black circle|Symbole
🔔|glocke benachrichtigung bell|Symbole
🔕|glocke aus stumm bell slash|Symbole
🎵|note musik musical note|Symbole
🎶|noten musik musical notes|Symbole
🆗|ok knopf ok button|Symbole
🆕|neu new button|Symbole
🆒|cool button|Symbole
🐶|hund welpe dog puppy|Tiere
🐱|katze cat|Tiere
🐭|maus mouse|Tiere
🐹|hamster|Tiere
🐰|hase kaninchen rabbit bunny|Tiere
🦊|fuchs fox|Tiere
🐻|bär bear|Tiere
🐼|panda|Tiere
🐨|koala|Tiere
🐯|tiger|Tiere
🦁|löwe lion|Tiere
🐮|kuh cow|Tiere
🐷|schwein pig|Tiere
🐸|frosch frog|Tiere
🐵|affe monkey|Tiere
🐔|huhn chicken|Tiere
🐧|pinguin penguin|Tiere
🐦|vogel bird|Tiere
🦆|ente duck|Tiere
🦅|adler eagle|Tiere
🦉|eule owl|Tiere
🐺|wolf|Tiere
🐴|pferd horse|Tiere
🦄|einhorn unicorn|Tiere
🐝|biene bee|Tiere
🐛|raupe käfer bug caterpillar|Tiere
🦋|schmetterling butterfly|Tiere
🐌|schnecke snail|Tiere
🐞|marienkäfer ladybug|Tiere
🐢|schildkröte turtle|Tiere
🐍|schlange snake python|Tiere
🐙|oktopus krake octopus|Tiere
🐬|delfin dolphin|Tiere
🐳|wal whale|Tiere
🦈|hai shark|Tiere
🐘|elefant elephant|Tiere
🦒|giraffe|Tiere
🐿️|eichhörnchen squirrel|Tiere
🦔|igel hedgehog|Tiere
🌵|kaktus cactus|Natur
🌲|tanne baum evergreen tree|Natur
🌳|baum laubbaum tree|Natur
🌴|palme palm tree|Natur
🌱|keimling pflanze seedling|Natur
🍀|kleeblatt glück four leaf clover luck|Natur
🍁|ahornblatt herbst maple leaf autumn|Natur
🍂|laub herbst fallen leaves|Natur
🌷|tulpe tulip|Natur
🌹|rose|Natur
🌻|sonnenblume sunflower|Natur
🌸|kirschblüte cherry blossom|Natur
💐|blumenstrauss bouquet flowers|Natur
🍎|apfel rot apple|Essen
🍐|birne pear|Essen
🍊|orange mandarine tangerine|Essen
🍋|zitrone lemon|Essen
🍌|banane banana|Essen
🍉|wassermelone watermelon|Essen
🍇|trauben grapes|Essen
🍓|erdbeere strawberry|Essen
🍒|kirschen cherries|Essen
🍑|pfirsich peach|Essen
🥭|mango|Essen
🍍|ananas pineapple|Essen
🥥|kokosnuss coconut|Essen
🥝|kiwi|Essen
🍅|tomate tomato|Essen
🥑|avocado|Essen
🥦|brokkoli broccoli|Essen
🥕|karotte rüebli carrot|Essen
🌽|mais corn|Essen
🌶️|chili scharf hot pepper|Essen
🥔|kartoffel potato|Essen
🥐|gipfeli croissant|Essen
🍞|brot bread|Essen
🥨|brezel pretzel|Essen
🧀|käse cheese|Essen
🥚|ei egg|Essen
🍳|spiegelei braten cooking egg|Essen
🥓|speck bacon|Essen
🍔|burger hamburger|Essen
🍟|pommes frites fries|Essen
🍕|pizza|Essen
🌭|hotdog wurst hot dog|Essen
🥪|sandwich|Essen
🌮|taco|Essen
🍝|spaghetti pasta nudeln|Essen
🍜|ramen nudelsuppe noodles|Essen
🍣|sushi|Essen
🍦|softeis ice cream|Essen
🍩|donut doughnut|Essen
🍪|keks cookie|Essen
🎂|geburtstagstorte birthday cake|Essen
🍰|kuchen torte cake shortcake|Essen
🍫|schokolade chocolate|Essen
🍬|bonbon candy|Essen
🍿|popcorn|Essen
☕|kaffee heissgetränk coffee hot beverage|Essen
🍵|tee tea|Essen
🧃|saft juice box|Essen
🥤|becher strohhalm drink cup|Essen
🍺|bier beer|Essen
🍻|prost anstossen bier cheers beers|Essen
🥂|anstossen sekt champagner clinking glasses|Essen
🍷|wein wine|Essen
🍸|cocktail martini|Essen
🍾|champagner flasche bottle popping cork|Essen
💧|tropfen wasser droplet water|Essen
⚽|fussball soccer football|Aktivitäten
🏀|basketball|Aktivitäten
🏈|american football|Aktivitäten
🎾|tennis|Aktivitäten
🏐|volleyball|Aktivitäten
🏓|tischtennis ping pong|Aktivitäten
⛳|golf|Aktivitäten
🎯|zielscheibe volltreffer direct hit target dart|Aktivitäten
🎮|spielen controller video game gaming|Aktivitäten
🎲|würfel dice game|Aktivitäten
🧩|puzzle|Aktivitäten
🎨|malen palette kunst art palette|Aktivitäten
🎬|film klappe clapper movie|Aktivitäten
🎤|mikrofon singen microphone karaoke|Aktivitäten
🎧|kopfhörer musik headphones|Aktivitäten
🎸|gitarre guitar|Aktivitäten
🎹|klavier piano keyboard|Aktivitäten
🏆|pokal trophäe sieg trophy win|Aktivitäten
🥇|gold erster platz gold medal first|Aktivitäten
🥈|silber zweiter platz silver medal|Aktivitäten
🥉|bronze dritter platz bronze medal|Aktivitäten
🎉|party konfetti feiern tada party popper celebrate|Aktivitäten
🎊|konfettiball confetti ball|Aktivitäten
🎈|ballon luftballon balloon|Aktivitäten
🎁|geschenk paket gift present|Aktivitäten
🎄|weihnachtsbaum christmas tree|Aktivitäten
🎃|kürbis halloween jack o lantern|Aktivitäten
🚗|auto car|Reisen
🚕|taxi|Reisen
🚌|bus|Reisen
🚑|krankenwagen ambulance|Reisen
🚒|feuerwehr fire engine|Reisen
🚓|polizei police car|Reisen
🚲|fahrrad velo bicycle bike|Reisen
🛴|trottinett scooter|Reisen
🏍️|motorrad motorcycle|Reisen
🚂|lokomotive zug locomotive train|Reisen
🚆|zug bahn train|Reisen
🚇|metro u-bahn subway|Reisen
✈️|flugzeug fliegen airplane plane flight|Reisen
🚀|rakete start rocket launch|Reisen
🛸|ufo flying saucer|Reisen
🚁|helikopter helicopter|Reisen
⛵|segelboot sailboat|Reisen
🚢|schiff ship|Reisen
⚓|anker anchor|Reisen
🗺️|karte weltkarte map|Reisen
🧭|kompass compass|Reisen
🏔️|berg schnee mountain|Reisen
🏖️|strand beach|Reisen
🏝️|insel island|Reisen
🏠|haus zuhause house home|Reisen
🏢|büro gebäude office building|Reisen
🏥|spital krankenhaus hospital|Reisen
🏫|schule school|Reisen
🌍|erde europa afrika globe earth|Reisen
🌎|erde amerika globe americas|Reisen
🌏|erde asien globe asia|Reisen
⌚|uhr armbanduhr watch|Objekte
📱|handy smartphone mobile phone|Objekte
💻|laptop computer notebook|Objekte
⌨️|tastatur keyboard|Objekte
🖥️|bildschirm desktop computer monitor|Objekte
🖨️|drucker printer|Objekte
🖱️|maus computer mouse|Objekte
💾|diskette speichern floppy disk save|Objekte
💿|cd disc|Objekte
📷|kamera foto camera photo|Objekte
🎥|filmkamera movie camera|Objekte
📺|fernseher tv television|Objekte
📻|radio|Objekte
🔋|batterie akku battery|Objekte
🔌|stecker plug|Objekte
💡|glühbirne idee light bulb idea|Objekte
🔦|taschenlampe flashlight|Objekte
🕯️|kerze candle|Objekte
💸|geld fliegt money wings|Objekte
💰|geldsack money bag|Objekte
💳|kreditkarte credit card|Objekte
💎|diamant edelstein gem diamond|Objekte
🔧|schraubenschlüssel wrench tool|Objekte
🔨|hammer|Objekte
🛠️|werkzeug hammer schlüssel tools|Objekte
⚙️|zahnrad einstellungen gear settings|Objekte
🔩|schraube mutter nut bolt|Objekte
🧲|magnet|Objekte
🧪|reagenzglas test tube|Objekte
🔬|mikroskop microscope|Objekte
🔭|teleskop telescope|Objekte
💊|pille medikament pill|Objekte
🧹|besen broom|Objekte
🛒|einkaufswagen shopping cart|Objekte
🔑|schlüssel key|Objekte
🔒|schloss gesperrt locked lock|Objekte
🔓|schloss offen unlocked|Objekte
🚪|tür door|Objekte
🛏️|bett bed|Objekte
✉️|brief umschlag envelope mail|Objekte
📧|e-mail email|Objekte
📦|paket box package|Objekte
📮|briefkasten postbox|Objekte
📝|notiz memo note|Objekte
📄|dokument seite page document|Objekte
📁|ordner folder|Objekte
📂|ordner offen open folder|Objekte
📅|kalender calendar|Objekte
📆|abreisskalender tear off calendar|Objekte
📈|diagramm steigend chart increasing|Objekte
📉|diagramm fallend chart decreasing|Objekte
📊|balkendiagramm bar chart|Objekte
📋|klemmbrett zwischenablage clipboard|Objekte
📌|pin reisszwecke pushpin|Objekte
📎|büroklammer paperclip|Objekte
✂️|schere scissors|Objekte
🖊️|stift pen|Objekte
✏️|bleistift pencil|Objekte
📚|bücher books|Objekte
📖|buch offen open book|Objekte
🔍|lupe suchen magnifying glass search|Objekte
🔗|link kette chain link|Objekte
📣|megafon megaphone|Objekte
⏰|wecker alarm clock|Objekte
⏳|sanduhr hourglass|Objekte
🧯|feuerlöscher fire extinguisher|Objekte
🇨🇭|schweiz flagge switzerland swiss flag|Flaggen
🇩🇪|deutschland flagge germany flag|Flaggen
🇦🇹|österreich flagge austria flag|Flaggen
🇫🇷|frankreich flagge france flag|Flaggen
🇮🇹|italien flagge italy flag|Flaggen
🇪🇸|spanien flagge spain flag|Flaggen
🇬🇧|grossbritannien england flagge uk united kingdom flag|Flaggen
🇺🇸|usa amerika flagge united states flag|Flaggen
🇪🇺|europa eu flagge european union flag|Flaggen
🏳️‍🌈|regenbogenflagge pride rainbow flag|Flaggen
🏁|zielflagge karo chequered flag finish|Flaggen
→|pfeil rechts arrow right|Zeichen
←|pfeil links arrow left|Zeichen
↑|pfeil oben arrow up|Zeichen
↓|pfeil unten arrow down|Zeichen
↔|pfeil links rechts arrow left right|Zeichen
⇒|doppelpfeil folgt implies double arrow right|Zeichen
⇔|äquivalent doppelpfeil if and only if|Zeichen
↩|zurück pfeil return arrow|Zeichen
±|plusminus plus minus|Zeichen
×|mal multiplikation times multiplication|Zeichen
÷|geteilt division divide|Zeichen
≈|ungefähr approximately|Zeichen
≠|ungleich not equal|Zeichen
≤|kleiner gleich less than or equal|Zeichen
≥|grösser gleich greater than or equal|Zeichen
∞|unendlich infinity|Zeichen
√|wurzel square root|Zeichen
∑|summe sigma sum|Zeichen
∏|produkt product|Zeichen
∆|delta differenz difference|Zeichen
π|pi|Zeichen
µ|mikro my micro mu|Zeichen
Ω|ohm omega|Zeichen
°|grad degree|Zeichen
‰|promille per mille|Zeichen
½|halb einhalb one half|Zeichen
¼|viertel one quarter|Zeichen
¾|dreiviertel three quarters|Zeichen
¹|hoch eins superscript one|Zeichen
²|hoch zwei quadrat superscript two squared|Zeichen
³|hoch drei kubik superscript three cubed|Zeichen
€|euro währung euro currency|Zeichen
£|pfund sterling pound currency|Zeichen
$|dollar|Zeichen
¥|yen yuan|Zeichen
¢|cent|Zeichen
₿|bitcoin|Zeichen
₹|rupie rupee|Zeichen
–|halbgeviertstrich gedankenstrich en dash|Zeichen
—|geviertstrich em dash|Zeichen
…|auslassungspunkte ellipsis|Zeichen
„|anführungszeichen unten deutsch low double quote german|Zeichen
“|anführungszeichen oben left double quote|Zeichen
”|anführungszeichen schliessend right double quote|Zeichen
‚|einfaches anführungszeichen unten single low quote|Zeichen
‘|einfaches anführungszeichen links left single quote|Zeichen
’|apostroph rechts right single quote apostrophe|Zeichen
«|guillemets links schweiz angle quote left|Zeichen
»|guillemets rechts schweiz angle quote right|Zeichen
‹|einfaches guillemet links single angle quote left|Zeichen
›|einfaches guillemet rechts single angle quote right|Zeichen
•|aufzählungspunkt bullet|Zeichen
·|mittelpunkt middle dot|Zeichen
§|paragraf paragraph section sign|Zeichen
¶|absatz pilcrow|Zeichen
©|copyright|Zeichen
®|registered eingetragene marke|Zeichen
™|trademark marke|Zeichen
†|kreuz gestorben dagger|Zeichen
✓|haken check mark|Zeichen
✗|kreuz ballot x|Zeichen
★|stern gefüllt black star|Zeichen
☆|stern leer white star|Zeichen
♥|herz heart suit|Zeichen
♪|note musik music note|Zeichen
⌘|befehlstaste command key|Zeichen
⌥|optionstaste option alt key|Zeichen
⇧|umschalttaste shift key|Zeichen
⌃|steuerungstaste control key|Zeichen
⏎|eingabetaste return enter key|Zeichen
⌫|rücktaste backspace|Zeichen
⇥|tabulator tab key|Zeichen
⎋|escape taste esc key|Zeichen
`;

// Category ids, their names for display, and the words that find them in
// either language.
const CATEGORIES = {
    Smileys: ['smileys', N_('Smileys'), ['smileys', 'smiley', 'gesichter', 'faces']],
    Gesten: ['gestures', N_('Gestures'), ['gesten', 'gestures', 'hände', 'hands']],
    Herzen: ['hearts', N_('Hearts'), ['herzen', 'hearts', 'liebe', 'love']],
    Tiere: ['animals', N_('Animals'), ['tiere', 'animals']],
    Natur: ['nature', N_('Nature'), ['natur', 'nature', 'wetter', 'weather']],
    Essen: ['food', N_('Food'), ['essen', 'food', 'trinken', 'drinks']],
    Reisen: ['travel', N_('Travel'), ['reisen', 'travel', 'orte', 'places']],
    Aktivitäten: ['activities', N_('Activities'), ['aktivitäten', 'activities', 'sport']],
    Objekte: ['objects', N_('Objects'), ['objekte', 'objects', 'dinge', 'things']],
    Symbole: ['symbols', N_('Symbols'), ['symbole', 'symbols']],
    Flaggen: ['flags', N_('Flags'), ['flaggen', 'flags', 'fahnen']],
    Zeichen: ['chars', N_('Characters'), ['zeichen', 'characters', 'sonderzeichen', 'special characters']],
};
const BY_ID = Object.fromEntries(Object.values(CATEGORIES).map(([id, title, terms]) => [id, {title, terms}]));
export const emojiCategoryLabel = id => (BY_ID[id] ? _(BY_ID[id].title) : id);
export const emojiCategoryTerms = id => BY_ID[id]?.terms ?? [id];

export const EMOJI = DATA.trim().split('\n').map(line => {
    const [char, names, category] = line.split('|');
    return {char, names, category: CATEGORIES[category]?.[0] ?? 'symbols'};
});
