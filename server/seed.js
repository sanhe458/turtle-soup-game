const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const config = require('./src/config');

// 直接用内存数据库或文件数据库重建
const DB_PATH = path.join(__dirname, 'data.db');
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('[seed] 已删除旧 data.db');
}

const db = require('./src/db');

// 管理员
const adminId = uuidv4();
const adminPassword = config.adminDefaultPassword;
const adminHash = bcrypt.hashSync(adminPassword, 10);
db.prepare(`
  INSERT INTO admins (id, account, password_hash, name, role, email)
  VALUES (?, ?, ?, ?, ?, ?)
`).run(adminId, 'admin', adminHash, 'SuperAdmin', '超级管理员', 'admin@turtlesoup.com');
console.log(`[seed] 管理员已创建: admin / ${adminPassword}`);

// 题目
const puzzles = [
  {
    title: '海边的神秘脚印',
    scenario: '一个男人在海边散步时，发现沙滩上有一串从大海方向延伸而来的脚印，但他并不感到害怕，反而笑了。为什么？',
    truth: '这个男人是一名海洋生物学家。他每天都会来海边观察海龟上岸产卵。沙滩上那一串脚印，是他一直在研究的那只海龟的。看到海龟又回来了，他非常高兴，所以笑了。',
    difficulty: 'easy',
    status: 'online',
    tags: ['海洋', '情感', '职业'],
    playCount: 2847,
    rating: 94,
  },
  {
    title: '午夜的来电',
    scenario: '深夜，一个女人接到一个电话。电话那头没有人说话，只有呼吸声。她挂断电话后却露出了安心的微笑。',
    truth: '这个女人的丈夫是消防员，正在执行一场严重的火灾救援任务。她一直联系不上他非常担心。那个电话其实是她丈夫在救援间隙偷偷打的，因为环境嘈杂他无法说话，但用呼吸声告诉妻子自己还活着。',
    difficulty: 'medium',
    status: 'online',
    tags: ['悬疑', '情感'],
    playCount: 2341,
    rating: 91,
  },
  {
    title: '消失的钥匙',
    scenario: '一个女人把家门钥匙放在了桌子上，第二天早上钥匙不见了，门窗都完好无损，家里也没有其他人。但一周后，钥匙又出现在了原来的位置。',
    truth: '这个女人养了一只爱捣蛋的猫。猫趁她不注意把钥匙叼走，藏到了沙发底下。一周后大扫除时，她挪动沙发才发现钥匙，又把它放回了桌上。',
    difficulty: 'easy',
    status: 'online',
    tags: ['推理', '生活'],
    playCount: 1986,
    rating: 88,
  },
  {
    title: '最后的晚餐',
    scenario: '一个富翁在自己家里举办晚宴，宴请了五位客人。晚宴结束后，富翁被发现死在书房里，但桌上的食物都验过没有毒。侦探却锁定了一位客人。',
    truth: '富翁对花生有严重的过敏反应。其中一位客人知道这件事，故意在餐前吃了很多含花生的食物，在与富翁握手寒暄时，花生蛋白残留在富翁手上。富翁随后用手拿食物吃，引发严重过敏休克而死。',
    difficulty: 'hard',
    status: 'online',
    tags: ['推理', '悬疑', '密室'],
    playCount: 3456,
    rating: 96,
  },
  {
    title: '空房间里的钟',
    scenario: '一个人租了一间便宜的公寓，房东只提了一个要求：永远不要进入锁着的那个房间。一天他忍不住偷偷打开了那个房间，里面只有一座老式落地钟。他立即退租搬走了。',
    truth: '那个房间曾经发生过一起命案，受害者被藏在落地钟里。那座钟就是当年的凶器现场。房东低价出租是为了掩盖这段往事。房客打开门时，闻到了残留的消毒水味，看到钟门内侧有未清理干净的划痕，立刻意识到不对劲。',
    difficulty: 'hard',
    status: 'online',
    tags: ['悬疑', '恐怖'],
    playCount: 1654,
    rating: 92,
  },
  {
    title: '雨天的伞',
    scenario: '下雨天，一个人撑着伞走在路上，却故意把伞收起来淋雨。旁边的朋友问他为什么，他说"这样它才能找到我"。',
    truth: '这个人是一名导盲犬训练师。他正在训练一只失明的导盲犬通过气味和声音定位主人。撑伞会遮住主人的气味和声音轮廓，收起伞让雨水把气味带向狗狗，便于它循着气味找到主人。',
    difficulty: 'medium',
    status: 'online',
    tags: ['情感', '职业'],
    playCount: 1320,
    rating: 89,
  },
];

const insertPuzzle = db.prepare(`
  INSERT INTO puzzles (id, title, scenario, truth, difficulty, status, tags, play_count, rating)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);
puzzles.forEach((p) => {
  insertPuzzle.run(
    uuidv4(),
    p.title,
    p.scenario,
    p.truth,
    p.difficulty,
    p.status,
    JSON.stringify(p.tags),
    p.playCount,
    p.rating
  );
});
console.log(`[seed] 已创建 ${puzzles.length} 道题目`);

console.log('[seed] 种子数据初始化完成');
console.log('[seed] 管理员登录: 账号 admin / 密码', adminPassword);
