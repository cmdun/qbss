import TossupBonusClient from './TossupBonusClient.js';
import localHistory from '../scripts/local-history.js';
import { MODE_ENUM } from '../../shared/constants.js';
import { QUESTION_CLIENT_MESSAGE_TYPE } from '../../shared/protocol/question-room.js';

export default class SoloTossupBonusClient extends TossupBonusClient {
  onmessage (message) {
    const data = JSON.parse(message);
    if (data.type === 'alert' && /^Successfully uploaded \d+ tossups and \d+ bonuses\.$/.test(data.message)) { return; }
    if (data.type === QUESTION_CLIENT_MESSAGE_TYPE.NO_QUESTIONS_FOUND && this.room.mode === MODE_ENUM.LOCAL) {
      return window.alert('No more questions are available in this practice packet.');
    }
    return super.onmessage(message);
  }

  clearStats () {
    this.updateScoreline();
  }

  updateScoreline () {
    const player = this.room.players[this.USER_ID];
    const bonusPoints = Object.entries(this.room.teams[player.teamId].bonusStats)
      .reduce((sum, [points, count]) => sum + Number(points) * count, 0);
    const tossupPoints = player.points;
    document.getElementById('local-scoreline').textContent = `Tossups: ${tossupPoints} pts · Bonuses: ${bonusPoints} pts · Total: ${tossupPoints + bonusPoints} pts`;
    const playerStats = this.room.players[this.USER_ID];
    const bonusStats = this.room.teams[player.teamId].bonusStats;
    const bonusCount = Object.values(bonusStats).reduce((sum, count) => sum + count, 0);
    const tossupStats = `${playerStats.superpowers ? `${playerStats.superpowers}/` : ''}${playerStats.powers}/${playerStats.tens}/${playerStats.negs} · ${playerStats.tuh} tossups · celerity ${(playerStats.celerity.correct.average || 0).toFixed(3)}`;
    const bonusBreakdown = Object.entries(bonusStats).sort((a, b) => Number(b[0]) - Number(a[0])).map(([points, count]) => `${points}: ${count}`).join(', ');
    document.getElementById('local-session-detail').textContent = `${tossupStats} · ${bonusCount ? (bonusPoints / bonusCount).toFixed(2) : '0.00'} PPB (${bonusCount} bonuses; ${bonusBreakdown})`;
  }

  buzz ({ userId }) {
    super.buzz({ userId });
    if (userId !== this.USER_ID) { return; }
    if (this.room.settings.typeToAnswer) {
      document.getElementById('answer-input-group').classList.remove('d-none');
      document.getElementById('answer-input').focus();
    } else {
      document.getElementById('buzz').disabled = false;
      document.getElementById('buzz').textContent = 'Reveal';
    }
  }

  startNextTossup (data) {
    super.startNextTossup(data);
    document.getElementById('toggle-correct').classList.add('d-none');
  }

  startNextBonus (data) {
    super.startNextBonus(data);
    document.getElementById('toggle-correct').classList.add('d-none');
  }

  revealTossupAnswer (data) {
    super.revealTossupAnswer(data);
    document.getElementById('buzz').disabled = true;
    document.getElementById('buzz').textContent = 'Buzz';
    const result = this.room.previousTossup;
    const button = document.getElementById('toggle-correct');
    button.classList.toggle('d-none', result?.userId !== this.USER_ID);
    button.textContent = result?.isCorrect ? 'I was wrong' : 'I was right';
  }

  toggleReadBonusesLikeTossups ({ readBonusLikeATossup }) {
    document.getElementById('toggle-read-bonuses-like-tossups').checked = readBonusLikeATossup;
  }

  setDifficulties () {}

  toggleCorrect ({ correct }) {
    this.updateScoreline();
    this.room.bonusEligibleTeamId = correct ? this.room.players[this.USER_ID].teamId : null;
    const button = document.getElementById('toggle-correct');
    if (button) { button.textContent = correct ? 'I was wrong' : 'I was right'; }
  }

  setMode ({ mode }) {
    const localSettings = document.getElementById('local-packet-settings');
    const setSettings = document.getElementById('set-settings');
    const difficultySettings = document.getElementById('difficulty-settings');
    localSettings.classList.toggle('d-none', mode !== MODE_ENUM.LOCAL);
    setSettings.classList.toggle('d-none', mode !== MODE_ENUM.SET_NAME);
    difficultySettings.classList.toggle('d-none', [MODE_ENUM.STARRED, MODE_ENUM.LOCAL].includes(mode));
    super.setMode({ mode });
  }

  toggleRandomizeOrder ({ randomizeOrder }) {
    document.getElementById('toggle-randomize-order').checked = randomizeOrder;
  }

  revealNextPart ({ currentPartNumber, part, value }) {
    super.revealNextPart({ currentPartNumber, part, value });
    const room = this.room;
    const userId = this.USER_ID;
    const input = document.getElementById(`checkbox-${currentPartNumber + 1}`);
    input?.addEventListener('click', function () {
      room.message(userId, { type: 'toggle-bonus-part', partNumber: currentPartNumber, correct: this.checked });
    });
  }

  endCurrentTossup ({ starred, tossup }) {
    super.endCurrentTossup({ starred, tossup });
    this.updateScoreline();
    const previous = this.room.previousTossup;
    if (!tossup) { return; }
    const scored = previous?.tossup?._id === tossup._id ? previous : {};
    const points = scored.isCorrect
      ? (scored.inSuperpower ? scored.superpowerValue : (scored.inPower ? scored.powerValue : 10))
      : (scored.endOfQuestion ? 0 : -(scored.negValue || 0));
    localHistory.record('tossup', tossup, {
      outcome: scored.isCorrect ? 'correct' : (scored.userId ? 'incorrect' : 'unanswered'),
      resultClass: scored.isCorrect ? ((scored.inPower || scored.inSuperpower) ? 'power' : 'get') : (scored.userId ? 'neg' : 'unanswered'),
      buzzPosition: scored.buzzPosition,
      celerity: scored.celerity,
      points,
      possiblePoints: 10
    });
  }

  endCurrentBonus ({ bonus, lastPartRevealed, pointsPerPart, starred, stats, teamId }) {
    super.endCurrentBonus({ bonus, lastPartRevealed, pointsPerPart, starred, stats, teamId });
    this.updateScoreline();
    const points = pointsPerPart.reduce((sum, value) => sum + (Number(value) || 0), 0);
    const values = bonus.values ?? bonus.parts.map(() => 10);
    localHistory.record('bonus', bonus, {
      outcome: lastPartRevealed ? 'complete' : 'partial',
      points,
      possiblePoints: values.reduce((sum, value) => sum + (Number(value) || 0), 0),
      bonusPartResults: pointsPerPart,
      bonusPartPossible: values
    });
  }

  giveTossupAnswer (data) {
    super.giveTossupAnswer(data);
    this.updateScoreline();
  }
}
