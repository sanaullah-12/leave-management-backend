/**
 * Template registry.
 *
 * Every template is a pure function: data in, { subject, html, text } out.
 * No template sends anything or touches the transport — that keeps them
 * trivially testable and swappable.
 */

module.exports = {
  invitation: require("./invitation"),
  welcome: require("./welcome"),
  forgotPassword: require("./forgotPassword"),
  passwordReset: require("./passwordReset"),
  leaveRequest: require("./leaveRequest"),
  leaveApproved: require("./leaveApproved"),
  leaveRejected: require("./leaveRejected"),
  employeeVoice: require("./employeeVoice"),
  announcement: require("./announcement"),
};
