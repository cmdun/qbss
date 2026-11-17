import CategoryManager from '../../shared/category-manager.js';
import TossupBonusRoom from '../../shared/rooms/TossupBonusRoom.js';
import api from '../scripts/api/index.js';
import { BONUS_PROGRESS_ENUM, TOSSUP_PROGRESS_ENUM, QUESTION_TYPE_ENUM, MODE_ENUM } from '../../shared/constants.js';

async function getPacket ({ setName, packetNumber }) {
  const [tossups, bonuses] = await Promise.all([
    setName ? api.getPacketTossups(setName, packetNumber ?? 1) : [],
    setName ? api.getPacketBonuses(setName, packetNumber ?? 1) : []
  ]);
  return { tossups, bonuses };
}

async function getStarredTossup () {
  const ids = await fetch('/auth/stars/tossup-ids').then(response => response.json());
  const id = drawStarred('tossup', ids);
  return id ? api.getTossup(id) : null;
}

async function getStarredBonus () {
  const ids = await fetch('/auth/stars/bonus-ids').then(response => response.json());
  const id = drawStarred('bonus', ids);
  return id ? api.getBonus(id) : null;
}

const starredDrawn = { tossup: new Set(), bonus: new Set() };
function drawStarred (type, ids) {
  const remaining = ids.filter(id => !starredDrawn[type].has(id));
  if (!remaining.length) { return null; }
  const id = remaining[Math.floor(Math.random() * remaining.length)];
  starredDrawn[type].add(id);
  return id;
}

export default class SoloTossupBonusRoom extends TossupBonusRoom {
  checkAnswer = api.checkAnswer;
  getPacket = getPacket;
  getPacketCount = api.getNumPackets;
  getRandomTossups = api.getRandomTossup;
  getRandomBonuses = api.getRandomBonus;
  getStarredTossup = getStarredTossup;
  getStarredBonus = getStarredBonus;

  constructor (name, categoryManager = new CategoryManager()) {
    super(name, categoryManager);
    this.settings = { ...this.settings, enableBonuses: false, skip: true, showHistory: true, typeToAnswer: true };
    this.practiceType = 'combined';
  }

  async next (player) {
    const isBonus = this.currentQuestionType === QUESTION_TYPE_ENUM.BONUS;
    const hasCurrent = isBonus
      ? this.bonusProgress !== BONUS_PROGRESS_ENUM.NOT_STARTED
      : this.tossupProgress !== TOSSUP_PROGRESS_ENUM.NOT_STARTED;
    if (hasCurrent) {
      const allowed = isBonus ? this.endCurrentBonus(player) : this.endCurrentTossup(player);
      if (!allowed) { return; }
    }
    if (this.practiceType === 'bonuses') { return this.startNextBonus(player); }
    if (this.practiceType === 'tossups') { return this.startNextTossup(player); }
    let bonusAvailable = this.mode !== MODE_ENUM.LOCAL || this.localPacket.bonuses.length > 0;
    if (this.mode === MODE_ENUM.STARRED) {
      const ids = await fetch('/auth/stars/bonus-ids').then(response => response.json());
      bonusAvailable = ids.some(id => !starredDrawn.bonus.has(id));
    }
    if (hasCurrent && !isBonus && bonusAvailable && (!this.settings.enableBonuses || this.bonusEligibleTeamId)) {
      this.bonusEligibleTeamId = this.players[player.userId].teamId;
      return this.startNextBonus(player);
    }
    return this.startNextTossup(player);
  }

  canUserAnswerBonus () {
    return true;
  }

  setMode (player, message) {
    if (message.mode === MODE_ENUM.STARRED) {
      starredDrawn.tossup.clear();
      starredDrawn.bonus.clear();
    }
    return super.setMode(player, message);
  }

  get liveAnswer () { return document.getElementById('answer-input')?.value ?? ''; }
  set liveAnswer (value) { const input = document.getElementById('answer-input'); if (input) { input.value = value; } }

  buzz (player) {
    if (!this.settings.typeToAnswer && this.buzzes.includes(player.userId)) {
      return this.giveTossupAnswer(player, { givenAnswer: this.tossup.answer_sanitized });
    }
    return super.buzz(player);
  }

  startBonusAnswer (player) {
    if (!this.settings.typeToAnswer) {
      return this.giveBonusAnswer(player, { givenAnswer: this.bonus.answers_sanitized[this.currentPartNumber] });
    }
    return super.startBonusAnswer(player);
  }

  startNextTossup (player) {
    this.bonusEligibleTeamId = null;
    return super.startNextTossup(player);
  }
}
