// Fixed guest code captures its primitives before the script can modify them.
// User code is an AsyncFunction body, rather than interpolated source around
// host bindings. Every host callback receives primitives only.
export const scriptPrelude = `(function(call, text, show, received) {
  const stringify = JSON.stringify, parse = JSON.parse, apply = Reflect.apply;
  const then = Promise.prototype.then, string = String;
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const failure = error => {
    try { return stringify({ok:false,code:'script_error',message:string(error)}); }
    catch { return '{"ok":false,"code":"script_error","message":"The script threw an unreadable error."}'; }
  };
  const output = (...values) => text(values.map(value => typeof value === 'string' ? value : value === undefined ? 'undefined' : stringify(value)).join(' '));
  Object.defineProperties(globalThis, {
    tools: {value:Object.freeze({call(name, args={}) {return apply(then,call(name,stringify(args)),[encoded=>{const result=parse(encoded); received(result.callId); return result;}]);}})},
    print: {value:output},
    show: {value:result=>show(result.callId)},
    console: {value:Object.freeze({log:output,info:output,warn:output,error:output})}
  });
  return function(source, argsJson) {
    try {
      const task = new AsyncFunction('args',source)(parse(argsJson));
      return apply(then,task,[value=>{
        try {return stringify({ok:true,value:value===undefined?null:value});}
        catch(error){return failure(error);}
      },failure]);
    } catch(error) {return failure(error);}
  };
})`
