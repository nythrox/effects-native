const c = function (chainer) {
  return new Chain(chainer, this);
};
const m = function (mapper) {
  return new Chain((e) => pure(mapper(e)), this);
};
class Of {
  constructor(value) {
    this.value = value;
  }
}
Of.prototype.chain = c;
Of.prototype.map = m;
class Chain {
  constructor(chainer, after) {
    this.chainer = chainer;
    this.after = after;
  }
}
Chain.prototype.chain = c;
Chain.prototype.map = m;
class Perform {
  constructor(key, args, options) {
    this.key = key;
    this.args = args;
    this.options = options;
  }
}
Perform.prototype.chain = c;
Perform.prototype.map = m;
class Handler {
  constructor(handlers, program) {
    this.handlers = handlers;
    this.program = program;
  }
}
Handler.prototype.chain = c;
Handler.prototype.map = m;
class Resume {
  constructor(cont, value) {
    this.cont = cont;
    this.value = value;
  }
}
Resume.prototype.chain = c;
Resume.prototype.map = m;
class SingleCallback {
  constructor(callback) {
    this.callback = callback;
  }
}
SingleCallback.prototype.chain = c;
SingleCallback.prototype.map = m;

const pure = (value) => new Of(value);

const chain = (chainer) => (action) => new Chain(chainer, action);

const map = (mapper) => (action) =>
  new Chain((val) => pure(mapper(val)), action);

const _effect = (key) => (...args) => new Perform(key, args);

const options = (options) => (perform) => (
  (perform.options = options), perform
);

const _perform = (key, ...args) => new Perform(key, args);

const _handler = (handlers) => (program) => new Handler(handlers, program);

const _resume = (continuation, value) => new Resume(continuation, value);

const _singleCallback = (callback) => new SingleCallback(callback);

const findHandlers = (key) => (context) => (onError) => {
  let curr = context;
  while (curr) {
    const action = curr.action;
    if (curr.action.constructor === Handler) {
      const handler = action.handlers[key];
      if (handler) {
        return [handler, curr.transformCtx];
      }
    }
    curr = curr.prev;
  }
  onError(Error("Handler not found: " + key.toString()));
};

class Interpreter {
  constructor(onDone, onError, context) {
    this.context = context;
    this.onError = onError;
    this.onDone = onDone;
    this.isPaused = true;
  }
  run() {
    this.isPaused = false;
    while (this.context) {
      const action = this.context.action;
      const context = this.context;
      // console.log(context, context.action);
      switch (action.constructor) {
        case Chain: {
          // const nested = action.after;
          // switch (nested.type) {
          //   case "of": {
          //     this.context = {
          //       handlers: context.handlers,
          //       prev: context.prev,
          //       resume: context.resume,
          //       action: action.chainer(nested.value)
          //     };
          //     break;
          //   }
          //   default: {}}
          this.context = {
            prev: context,
            action: action.after
          };
          break;
        }
        case Of: {
          this.return(action.value, context);
          break;
        }
        case SingleCallback: {
          this.context = undefined;
          action.callback((value) => {
            this.return(value, context);
            if (this.isPaused) {
              this.run();
            }
          });
          break;
        }
        case Handler: {
          const { handlers, program } = action;
          const transformCtx = {
            prev: context,
            action: program
          };
          const lastPrev = context.prev;
          context.prev = {
            prev: lastPrev,
            action: handlers.return
              ? program.chain(handlers.return)
              : program.chain(pure)
          };
          context.transformCtx = context.prev;
          this.context = transformCtx;
          break;
        }
        case Perform: {
          const { args, options } = action;
          const h = findHandlers(action.key)(
            options && options.scope ? options.scope.programCtx : context
          )(this.onError);
          if (!h) return;
          const [handler, transformCtx] = h;
          const handlerAction = handler(...args, {
            transformCtx,
            programCtx: context
          });
          const activatedHandlerCtx = {
            // 1. Make the activated handler returns to the *return transformation* parent,
            // and not to the *return transformation* directly (so it doesn't get transformed)
            prev: transformCtx.prev,
            action: handlerAction
          };
          this.context = activatedHandlerCtx;
          break;
        }
        case Resume: {
          // inside activatedHandlerCtx
          const { value, cont } = action;
          // context of the transformer, context of the program to continue
          if (!cont || !(cont && cont.transformCtx && cont.programCtx)) {
            this.onError(Error("Missing continuation parameter in resume"));
            return;
          }
          const { transformCtx, programCtx } = cont;
          // 3. after the transformation is done, return to the person chaining `resume`
          // /\ when the person chaining resume (activatedHandlerCtx) is done, it will return to the transform's parent
          transformCtx.prev = context.prev;
          // 2. continue the main program with resumeValue,
          // and when it finishes, let it go all the way through the *return* transformation proccess
          // /\ it goes all the way beacue it goes to programCtx.prev (before perform) that will eventually fall to transformCtx
          this.return(value, programCtx);
          break;
        }
        default: {
          this.onError(Error("Invalid instruction: " + JSON.stringify(action)));
          return;
        }
      }
    }
    this.isPaused = true;
  }
  return(value, currCtx) {
    const prev = currCtx && currCtx.prev;
    if (prev) {
      switch (prev.action.constructor) {
        case Handler: {
          this.return(value, prev);
          break;
        }
        case Chain: {
          this.context = {
            prev: prev.prev,
            action: prev.action.chainer(value)
          };
          break;
        }
        default: {
          this.onError(new Error("Invalid state"));
        }
      }
    } else {
      this.onDone(value);
      this.context = undefined;
    }
  }
}
const _io = effect("io");
const _withIo = handler({
  return: (value) => pure(() => value),
  io: (thunk, k) => resume(k, thunk())
});

const _forEach = effect("forEach");

const _withForEach = handler({
  return: (val) => pure([val]),
  forEach: (array, k) => {
    const nextInstr = (newArr = []) => {
      if (array.length === 0) {
        return pure(newArr);
      } else {
        const first = array.shift();
        return resume(k, first).chain((a) => {
          for (const item of a) {
            newArr.push(item);
          }
          return nextInstr(newArr);
        });
      }
    };
    return nextInstr();
  }
});

const _raise = effect("error");
const _handleError = (handleError) =>
  handler({
    error: (exn, k) => handleError(k, exn)
  });
const _toEither = handler({
  return: (value) =>
    pure({
      type: "right",
      value
    }),
  error: (exn) =>
    pure({
      type: "left",
      value: exn
    })
});
const _waitFor = effect("async");

const _withIoPromise = handler({
  return: (value) => pure(Promise.resolve(value)),
  async: (iopromise, k) =>
    io(iopromise).chain((promise) =>
      singleCallback((done) => {
        promise
          .then((value) => {
            done({ success: true, value });
          })
          .catch((error) => {
            done({ success: false, error });
          });
      }).chain((res) =>
        res.success
          ? resume(k, res.value)
          : options({
              scope: k
            })(raise(res.value)).chain((e) => resume(k, e))
      )
    )
});
const _run = (program) =>
  new Promise((resolve, reject) => {
    new Interpreter(
      (thunk) => {
        const either = thunk();
        if (either.type === "right") {
          resolve(either.value);
        } else {
          reject(either.value);
        }
      },
      reject,
      {
        prev: undefined,
        action: withIo(toEither(withIoPromise(program)))
      }
    ).run();
  });

/** effectful expression throws this object if it requires suspension */
const token = {};

/** Pointer to mutable data used to record effectful computations */
let context;

/** Runs `thunk()` as an effectful expression with `of` and `chain` as Monad's definition */
const toAction = (thunk) => {
  /** here it caches effects requests */
  const trace = [];
  const ctx = { trace };
  const res = step();
  return res;
  function step() {
    const savedContext = context;
    ctx.pos = 0;
    try {
      context = ctx;
      return pure(thunk());
    } catch (e) {
      /** re-throwing other exceptions */
      if (e !== token) throw e;
      const { pos } = ctx;

      return new Chain((value) => {
        trace.length = pos;
        /* recording the resolved value */
        trace[pos] = value;
        ctx.pos = pos + 1;
        /** replay */
        return step(value);
      }, ctx.effect);
    } finally {
      context = savedContext;
    }
  }
};
/** marks effectful expression */
const perform = (monad) => {
  /* if the execution is in a replay stage the value will be cached */
  if (context.pos < context.trace.length) return context.trace[context.pos++];
  /* saving the expression to resolve in `run` */
  context.effect = monad;
  throw token;
};

const effect = (key) => (...values) => {
  perform(_effect(key)(...values));
};

const toModernHandler = (oldHandler) => (program) =>
  perform(oldHandler(toAction(program)));
const singleCallback = (callback) => perform(_singleCallback(callback));
const resume = (continuation, value) => perform(_resume(continuation, value));
const handler = (handlers) => (program) => {
  for (const handler in handlers) {
    const saved = handlers[handler];
    handlers[handler] = (...args) => {
      return toAction(() => saved(...args));
    };
  }
  return perform(_handler(handlers)(toAction(program)));
};
const use = effect("use");
const withUse = handler({
  use: (handler, k) => {
    return handler(() => resume(k));
  }
});
const run = (thunk) => _run(toAction(() => withUse(thunk)));
const io = (ioThunk) => perform(_io(ioThunk));
const waitFor = (ioPromise) => perform(_waitFor(ioPromise));
const forEach = (arr) => perform(_forEach(arr));
const withForEach = toModernHandler(_withForEach);
const withIo = toModernHandler(_withIo);
const raise = (err) => perform(_raise(err));
const print = effect("print");
const handleError = (handler) => toModernHandler(_handleError(handler));
const toEither = toModernHandler(_toEither);
const withIoPromise = toModernHandler(_withIoPromise);
const withPrint = handler({
  print(val, k) {
    io(() => console.log(val));
    return resume(k);
  }
});

const main = () => {
  use(withPrint);
  use(withForEach);
  const i = forEach([1, 2, 3]);
  if (!!false) {
    raise(new Error());
  }
  print("hi");
  const num = waitFor(() => Promise.resolve(2));
  return i * num;
};

// run(main).then(console.log).catch(console.error);

const getUser = effect("getUser");

const handleGetUser = handler({
  getUser: (id) => {
    const res = resume({
      id,
      name: "Jason"
    });
    const res1 = resume({
      id,
      name: "Rully"
    });
    return [res, res1];
  }
});

const program = () => {
  // const user = getUser(10);
  return {};
};

// run(() => ({})).then(console.log);

module.exports = {
  withForEach,
  forEach,
  run,
  io,
  withIo,
  Interpreter,
  singleCallback,
  chain,
  pure,
  map,
  handler,
  resume,
  perform,
  effect,
  toEither,
  waitFor,
  withIoPromise,
  raise,
  handleError,
  toAction,
  context,
  token
};
