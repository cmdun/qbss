export default class audio {
  static soundEffects = window.localStorage.getItem('sound-effects') === 'true';
  static buzz = new window.Audio('/docs/buzz.mp3');
  static correct = new window.Audio('/docs/correct.mp3');
  static incorrect = new window.Audio('/docs/incorrect.mp3');
  static power = new window.Audio('/docs/power.mp3');
}
