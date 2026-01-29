const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 游戏房间数据
const rooms = new Map();

// 静态文件服务
app.use(express.static('public'));

// 根路由
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log('✅ 新用户连接:', socket.id);

  // 创建房间
  socket.on('create-room', (data) => {
    try {
      const roomCode = generateRoomCode();
      const room = {
        code: roomCode,
        host: socket.id,
        players: [{
          id: socket.id,
          name: data.playerName,
          isHost: true
        }],
        gameStarted: false,
        gameState: null
      };
      
      rooms.set(roomCode, room);
      socket.join(roomCode);
      socket.emit('room-created', { roomCode, room });
      console.log(`✅ 房间已创建: ${roomCode}, 房主: ${data.playerName} (${socket.id}), 当前房间总数: ${rooms.size}`);
    } catch (error) {
      console.error('❌ 创建房间失败:', error);
      socket.emit('error', { message: '创建房间失败，请重试' });
    }
  });

  // 加入房间
  socket.on('join-room', (data) => {
    try {
      const roomCode = data.roomCode.toUpperCase();
      console.log(`🔍 尝试加入房间: ${roomCode}, 玩家: ${data.playerName} (${socket.id})`);
      console.log(`📊 当前存在的房间:`, Array.from(rooms.keys()));
      
      const room = rooms.get(roomCode);
      
      if (!room) {
        console.log(`❌ 房间不存在: ${roomCode}`);
        socket.emit('error', { message: `房间 ${roomCode} 不存在，请检查房间代码` });
        return;
      }

      if (room.gameStarted) {
        console.log(`❌ 游戏已开始: ${roomCode}`);
        socket.emit('error', { message: '游戏已开始，无法加入' });
        return;
      }

      // 检查是否已在房间中
      const existingPlayer = room.players.find(p => p.id === socket.id);
      if (!existingPlayer) {
        room.players.push({
          id: socket.id,
          name: data.playerName,
          isHost: false
        });
        console.log(`➕ 新玩家加入: ${data.playerName}`);
      } else {
        console.log(`♻️ 玩家重新连接: ${data.playerName}`);
      }

      socket.join(roomCode);
      io.to(roomCode).emit('room-updated', room);
      socket.emit('joined-room', room);
      console.log(`✅ ${data.playerName} 成功加入房间 ${roomCode}，当前玩家数: ${room.players.length}`);
    } catch (error) {
      console.error('❌ 加入房间失败:', error);
      socket.emit('error', { message: '加入房间失败，请重试' });
    }
  });

  // 开始游戏
  socket.on('start-game', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      
      if (!room) {
        socket.emit('error', { message: '房间不存在' });
        return;
      }

      if (room.host !== socket.id) {
        socket.emit('error', { message: '只有房主可以开始游戏' });
        return;
      }

      if (room.players.length < data.playerCount) {
        socket.emit('error', { message: `当前玩家不足，需要${data.playerCount}人，当前${room.players.length}人` });
        return;
      }

      room.gameStarted = true;
      room.gameState = initializeGame(room.players, data.playerCount);
      
      io.to(data.roomCode).emit('game-started', room.gameState);
      console.log(`🎮 游戏开始: ${data.roomCode}, ${data.playerCount}人局`);
    } catch (error) {
      console.error('❌ 开始游戏失败:', error);
      socket.emit('error', { message: '开始游戏失败，请重试' });
    }
  });

  // 同步游戏状态
  socket.on('update-game-state', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      if (room) {
        room.gameState = data.gameState;
        socket.to(data.roomCode).emit('game-state-updated', data.gameState);
      }
    } catch (error) {
      console.error('❌ 更新游戏状态失败:', error);
    }
  });

  // 获取游戏状态
  socket.on('get-game-state', (data) => {
    try {
      const room = rooms.get(data.roomCode);
      if (room && room.gameState) {
        socket.emit('game-state-updated', room.gameState);
      }
    } catch (error) {
      console.error('❌ 获取游戏状态失败:', error);
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log('❌ 用户断开连接:', socket.id);
    
    // 从所有房间中移除该玩家
    rooms.forEach((room, roomCode) => {
      const playerIndex = room.players.findIndex(p => p.id === socket.id);
      
      if (playerIndex !== -1) {
        const playerName = room.players[playerIndex].name;
        room.players.splice(playerIndex, 1);
        
        // 如果房间为空，删除房间
        if (room.players.length === 0) {
          rooms.delete(roomCode);
          console.log(`🗑️ 房间已删除: ${roomCode} (无玩家)`);
        } else {
          // 如果是房主离开，转移房主权限
          if (room.host === socket.id) {
            room.host = room.players[0].id;
            room.players[0].isHost = true;
            console.log(`👑 房主转移: ${roomCode} -> ${room.players[0].name}`);
          }
          io.to(roomCode).emit('room-updated', room);
          console.log(`👋 ${playerName} 离开房间 ${roomCode}，剩余玩家: ${room.players.length}`);
        }
      }
    });
  });
});

// 生成房间代码
function generateRoomCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // 确保代码唯一
  if (rooms.has(code)) {
    console.log(`⚠️ 房间代码冲突: ${code}, 重新生成`);
    return generateRoomCode();
  }
  return code;
}

// 初始化游戏
function initializeGame(players, totalPlayers) {
  const roles = getRoleConfig(totalPlayers);
  const shuffledRoles = shuffleArray([...roles]);
  
  const gamePlayers = players.slice(0, totalPlayers).map((player, index) => ({
    id: player.id,
    name: player.name,
    role: shuffledRoles[index],
    team: ['梅林', '派西维尔', '忠臣'].includes(shuffledRoles[index]) ? 'good' : 'evil'
  }));

  return {
    players: gamePlayers,
    currentRound: 1,
    currentLeader: 0,
    teamSize: getTeamSize(totalPlayers, 1),
    missions: [
      { round: 1, required: getTeamSize(totalPlayers, 1), failsNeeded: 1, result: null },
      { round: 2, required: getTeamSize(totalPlayers, 2), failsNeeded: 1, result: null },
      { round: 3, required: getTeamSize(totalPlayers, 3), failsNeeded: totalPlayers >= 7 ? 2 : 1, result: null },
      { round: 4, required: getTeamSize(totalPlayers, 4), failsNeeded: 1, result: null },
      { round: 5, required: getTeamSize(totalPlayers, 5), failsNeeded: 1, result: null }
    ],
    selectedTeam: [],
    votes: new Map(),
    missionVotes: new Map(),
    consecutiveRejects: 0,
    phase: 'team-building',
    gameOver: false,
    winner: null
  };
}

// 获取角色配置
function getRoleConfig(playerCount) {
  const configs = {
    5: ['梅林', '派西维尔', '忠臣', '莫甘娜', '刺客'],
    6: ['梅林', '派西维尔', '忠臣', '忠臣', '莫甘娜', '刺客'],
    7: ['梅林', '派西维尔', '忠臣', '忠臣', '莫甘娜', '刺客', '奥伯伦'],
    8: ['梅林', '派西维尔', '忠臣', '忠臣', '忠臣', '莫甘娜', '刺客', '爪牙'],
    9: ['梅林', '派西维尔', '忠臣', '忠臣', '忠臣', '忠臣', '莫甘娜', '刺客', '莫德雷德'],
    10: ['梅林', '派西维尔', '忠臣', '忠臣', '忠臣', '忠臣', '莫甘娜', '刺客', '莫德雷德', '奥伯伦']
  };
  return configs[playerCount] || configs[5];
}

// 获取队伍人数
function getTeamSize(playerCount, round) {
  const sizes = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5]
  };
  return (sizes[playerCount] || sizes[5])[round - 1];
}

// 打乱数组
function shuffleArray(array) {
  const newArray = [...array];
  for (let i = newArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
  }
  return newArray;
}

// 启动服务器
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 阿瓦隆服务器运行在端口 ${PORT}`);
  console.log(`🌐 访问地址: http://localhost:${PORT}`);
  console.log(`📊 服务器启动时间: ${new Date().toLocaleString('zh-CN')}`);
});
