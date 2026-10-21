// happy-dom does not run CSS transitions. Match the browser's empty animation
// list when no transitions are active; real motion is verified in Playwright.
Element.prototype.getAnimations = () => []
