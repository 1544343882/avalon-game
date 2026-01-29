const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});
const path = require('path');

// 存储所有房间数据
const rooms = new Map();

// 角色配置
const roleConfigs = {
    5: { good: 3, evil: 2, roles: ['梅林', '派西维尔', '忠臣', '莫甘娜', '刺客'] },
    6: { good: 4, evil: 2, roles: ['梅林', '派西维尔', '忠臣', '忠臣', '莫甘娜', '刺客'] },
    7: { good: 4, evil: 3, roles: ['梅林', '派西维尔', '忠臣', '忠臣', '莫甘娜', '刺客', '莫德雷德'] },
    8: { good: 5, evil: 3, roles: ['梅林', '派西维尔', '忠臣', '忠臣', '忠臣', '莫甘娜', '刺客', '奥伯伦'] },
    9: { good: 6, evil: 3, roles: ['梅林', '派西维尔', '忠臣', '忠臣', '忠臣', '忠臣', '莫甘娜', '刺客', '莫德雷德'] },
    10: { good: 6, evil: 4, roles: ['梅林', '派西维尔', '忠臣', '忠臣', '忠臣', '忠臣', '莫甘娜', '刺客', '莫德雷德', '奥伯伦'] }
};

const missionConfigs = {
    5: [2, 3, 2, 3, 3],
    6: [2, 3, 4, 3, 4],
    7: [2, 3, 3, 4, 4],
    8: [3, 4, 4, 5, 5],
    9: [3, 4, 4, 5, 5],
    10: [3, 4, 4, 5, 5]
};

// 提供静态文件
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// 工具函数
function generateRoomCode() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return code;
}

function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}

// Socket.io 连接处理
io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // 创建房间
    socket.on('createRoom', (nickname, callback) => {
        const roomCode = generateRoomCode();
        const room = {
            code: roomCode,
            host: nickname,
            players: [{
                id: socket.id,
                nickname: nickname,
                online: true
            }],
            status: 'lobby',
            gameState: null
        };
        
        rooms.set(roomCode, room);
        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.nickname = nickname;
        
        callback({ success: true, roomCode });
        console.log(`Room ${roomCode} created by ${nickname}`);
    });

    // 加入房间
    socket.on('joinRoom', (data, callback) => {
        const { roomCode, nickname } = data;
        const room = rooms.get(roomCode);

        if (!room) {
            callback({ success: false, error: '房间不存在' });
            return;
        }

        if (room.status !== 'lobby') {
            callback({ success: false, error: '游戏已开始，无法加入' });
            return;
        }

        if (room.players.some(p => p.nickname === nickname)) {
            callback({ success: false, error: '昵称已被使用' });
            return;
        }

        room.players.push({
            id: socket.id,
            nickname: nickname,
            online: true
        });

        socket.join(roomCode);
        socket.roomCode = roomCode;
        socket.nickname = nickname;

        callback({ success: true });
        io.to(roomCode).emit('roomUpdate', room);
        console.log(`${nickname} joined room ${roomCode}`);
    });

    // 开始游戏
    socket.on('startGame', (playerNum, callback) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.host !== socket.nickname) {
            callback({ success: false, error: '只有房主可以开始游戏' });
            return;
        }

        if (room.players.length < playerNum) {
            callback({ success: false, error: `需要至少${playerNum}名玩家` });
            return;
        }

        // 选择玩家并分配角色
        const selectedPlayers = shuffleArray(room.players).slice(0, playerNum);
        const roles = shuffleArray([...roleConfigs[playerNum].roles]);
        
        selectedPlayers.forEach((player, index) => {
            player.role = roles[index];
            player.viewed = false;
        });

        room.players = selectedPlayers;
        room.status = 'playing';
        room.gameState = {
            currentRound: 1,
            currentLeader: 0,
            leaderOrder: selectedPlayers.map(p => p.nickname),
            missions: [],
            teamRejections: 0,
            phase: 'team_building',
            team: [],
            votes: {},
            missionVotes: {},
            assassinTarget: null,
            log: ['游戏开始！']
        };

        callback({ success: true });
        io.to(socket.roomCode).emit('gameStart', room);
        console.log(`Game started in room ${socket.roomCode}`);
    });

    // 查看身份
    socket.on('viewRole', () => {
        const room = rooms.get(socket.roomCode);
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (player) {
            player.viewed = true;
            socket.emit('roleInfo', { 
                role: player.role, 
                players: room.players 
            });
        }
    });

    // 切换队伍成员
    socket.on('toggleTeamMember', (nickname) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameState.phase !== 'team_building') return;

        const currentLeader = room.gameState.leaderOrder[room.gameState.currentLeader];
        if (currentLeader !== socket.nickname) return;

        const team = room.gameState.team || [];
        const index = team.indexOf(nickname);
        
        if (index > -1) {
            room.gameState.team = team.filter(n => n !== nickname);
        } else {
            const playerNum = room.players.length;
            const teamSize = missionConfigs[playerNum][room.gameState.currentRound - 1];
            if (team.length < teamSize) {
                room.gameState.team = [...team, nickname];
            }
        }

        io.to(socket.roomCode).emit('gameUpdate', room);
    });

    // 确认队伍
    socket.on('confirmTeam', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameState.phase !== 'team_building') return;

        const currentLeader = room.gameState.leaderOrder[room.gameState.currentLeader];
        if (currentLeader !== socket.nickname) return;

        room.gameState.log.push(
            `第${room.gameState.currentRound}轮：队长${currentLeader}提议队伍：${room.gameState.team.join('、')}`
        );
        room.gameState.phase = 'team_voting';
        room.gameState.votes = {};

        io.to(socket.roomCode).emit('gameUpdate', room);
    });

    // 投票队伍
    socket.on('voteTeam', (approve) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameState.phase !== 'team_voting') return;

        room.gameState.votes[socket.nickname] = approve;

        // 检查是否所有人都投票了
        if (Object.keys(room.gameState.votes).length === room.players.length) {
            const approveCount = Object.values(room.gameState.votes).filter(v => v).length;
            const approved = approveCount > room.players.length / 2;
            
            room.gameState.log.push(
                `投票结果：${approveCount}同意 ${room.players.length - approveCount}反对 - ${approved ? '通过' : '拒绝'}`
            );
            
            if (approved) {
                room.gameState.phase = 'mission';
                room.gameState.missionVotes = {};
                room.gameState.teamRejections = 0;
            } else {
                room.gameState.teamRejections++;
                if (room.gameState.teamRejections >= 5) {
                    room.gameState.phase = 'game_over';
                    room.gameState.log.push('连续5次拒绝组队，邪恶方获胜！');
                } else {
                    room.gameState.phase = 'team_building';
                    room.gameState.currentLeader = (room.gameState.currentLeader + 1) % room.players.length;
                    room.gameState.team = [];
                }
            }
        }

        io.to(socket.roomCode).emit('gameUpdate', room);
    });

    // 投票任务
    socket.on('voteMission', (success) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameState.phase !== 'mission') return;

        if (!room.gameState.team.includes(socket.nickname)) return;

        room.gameState.missionVotes[socket.nickname] = success;

        // 检查是否所有队员都投票了
        if (Object.keys(room.gameState.missionVotes).length === room.gameState.team.length) {
            const fails = Object.values(room.gameState.missionVotes).filter(v => !v).length;
            const playerNum = room.players.length;
            const needTwoFails = room.gameState.currentRound === 4 && playerNum >= 7;
            const missionSuccess = needTwoFails ? fails < 2 : fails === 0;
            
            room.gameState.missions.push({ success: missionSuccess, fails });
            room.gameState.log.push(
                `第${room.gameState.currentRound}轮任务${missionSuccess ? '成功' : '失败'}（${fails}个失败）`
            );
            
            const goodWins = room.gameState.missions.filter(m => m.success).length;
            const evilWins = room.gameState.missions.filter(m => !m.success).length;
            
            if (goodWins >= 3) {
                room.gameState.phase = 'assassination';
                room.gameState.log.push('正义方完成3次任务！刺客准备刺杀梅林...');
            } else if (evilWins >= 3) {
                room.gameState.phase = 'game_over';
                room.gameState.log.push('邪恶方破坏3次任务，邪恶方获胜！');
            } else {
                room.gameState.currentRound++;
                room.gameState.currentLeader = (room.gameState.currentLeader + 1) % room.players.length;
                room.gameState.phase = 'team_building';
                room.gameState.team = [];
            }
        }

        io.to(socket.roomCode).emit('gameUpdate', room);
    });

    // 刺杀
    socket.on('assassinate', (target) => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.gameState.phase !== 'assassination') return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player || player.role !== '刺客') return;

        const targetPlayer = room.players.find(p => p.nickname === target);
        const assassinSuccess = targetPlayer.role === '梅林';
        
        room.gameState.assassinTarget = target;
        room.gameState.phase = 'game_over';
        room.gameState.log.push(`刺客刺杀了${target}！`);
        
        if (assassinSuccess) {
            room.gameState.log.push(`${target}是梅林！邪恶方获胜！`);
        } else {
            room.gameState.log.push(`${target}不是梅林！正义方获胜！`);
        }

        io.to(socket.roomCode).emit('gameUpdate', room);
    });

    // 返回大厅
    socket.on('returnToLobby', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.host !== socket.nickname) return;

        room.status = 'lobby';
        room.gameState = null;
        room.players.forEach(p => {
            p.role = null;
            p.viewed = false;
        });

        io.to(socket.roomCode).emit('returnToLobby', room);
    });

    // 删除房间
    socket.on('deleteRoom', () => {
        const room = rooms.get(socket.roomCode);
        if (!room || room.host !== socket.nickname) return;

        io.to(socket.roomCode).emit('roomDeleted');
        rooms.delete(socket.roomCode);
        console.log(`Room ${socket.roomCode} deleted`);
    });

    // 断开连接
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (socket.roomCode) {
            const room = rooms.get(socket.roomCode);
            if (room) {
                const player = room.players.find(p => p.id === socket.id);
                if (player) {
                    player.online = false;
                }
                
                // 如果房主离线且房间在大厅状态，删除房间
                if (room.host === socket.nickname && room.status === 'lobby') {
                    const allOffline = room.players.every(p => !p.online);
                    if (allOffline) {
                        rooms.delete(socket.roomCode);
                        console.log(`Room ${socket.roomCode} auto-deleted (all offline)`);
                    }
                } else {
                    io.to(socket.roomCode).emit('roomUpdate', room);
                }
            }
        }
    });
});

// 清理离线房间
setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, code) => {
        if (room.status === 'lobby') {
            const allOffline = room.players.every(p => !p.online);
            const isOld = now - (room.created || 0) > 3600000; // 1小时
            if (allOffline && isOld) {
                rooms.delete(code);
                console.log(`Room ${code} auto-deleted (inactive)`);
            }
        }
    });
}, 300000); // 每5分钟检查一次

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
