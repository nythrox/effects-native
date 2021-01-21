type Pure = { value: any; type: "Pure" };
type Chain = { chainer: (val: any) => Effect; after: Effect; type: "Chain" };
type Perform = {
  key: PropertyKey;
  args: any[];
  options?: { scope: ResumeContext };
  type: "Perform";
};
type Handler = {
  handlers: Handlers;
  program: Effect;
  type: "Handler";
};
type ResumeContext = {
  transformCtx: Context;
  programCtx: Context;
};
type Resume = {
  cont: ResumeContext;
  value: any;
  type: "Resume";
};
type SingleCallback = {
  type: "SingleCallback";
  callback: (done: (value: any) => void) => void;
};
type Effect<T = any> =
  | Pure
  | Chain
  | Perform
  | Handler
  | Resume
  | SingleCallback;
type Context = { action: Effect<any>; prev?: Context; transformCtx?: Context };
const pure = <T>(value: T) => ({ value, type: "Pure" } as Effect);

const chain = <T, T2>(chainer: (val: T) => Effect<T2>) => (action: Effect<T>) =>
  ({ chainer, after: action, type: "Chain" } as Effect);

const map = <T, T2>(mapper: (val: T) => T2) => (action: Effect<T>) =>
  chain((e: T) => pure(mapper(e)))(action) as Effect;

const _effect = <K extends PropertyKey, Args extends any[]>(key: K) => (
  ...args: Args
) => ({ key, args, options: undefined, type: "Perform" } as Perform);

const options = (options: { scope: ResumeContext }) => (perform: Perform) => (
  (perform.options = options), perform
);

const _perform = <K extends PropertyKey, Args extends any[]>(
  key: K,
  ...args: Args
) => ({ key, args, options: undefined, type: "Perform" } as Perform);
type Handlers = Record<PropertyKey, any>;
const _handler = (handlers: Handlers) => (program: Effect<any>) =>
  ({
    handlers,
    program,
    type: "Handler",
  } as Effect);

const _resume = (continuation: ResumeContext, value: any) =>
  ({
    cont: continuation,
    value,
    type: "Resume",
  } as Effect);

const singleCallback = <T>(callback: (done: (value: T) => void) => void) =>
  ({
    callback,
    type: "SingleCallback",
  } as Effect);

const findHandlers = (key: PropertyKey) => (context: Context) => (
  onError: (error: any) => void
) => {
  let curr = context as Context | undefined;
  while (curr) {
    const action = curr.action;
    if (action.type === "Handler") {
      const handler = action.handlers[key as string];
      if (handler) {
        return [handler, curr.transformCtx] as const;
      }
    }
    curr = curr.prev;
  }
  onError(Error("Handler not found: " + key.toString()));
};

class Interpreter {
  constructor(
    private onDone: (value: any) => void,
    private onError: (value: any) => void,
    private context: Context | undefined,
    private isPaused = true
  ) {}
  run() {
    this.isPaused = false;
    while (this.context) {
      const action = this.context.action;
      const context = this.context;
      switch (action.type) {
        case "Chain": {
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
            action: action.after,
          };
          break;
        }
        case "Pure": {
          this.return(action.value, context);
          break;
        }
        case "SingleCallback": {
          this.context = undefined;
          action.callback((value) => {
            this.return(value, context);
            if (this.isPaused) {
              this.run();
            }
          });
          break;
        }
        case "Handler": {
          const { handlers, program } = action;
          const transformCtx = {
            prev: context,
            action: handlers.return
              ? chain(handlers.return)(program)
              : chain(pure)(program),
          };
          context.transformCtx = transformCtx;
          this.context = transformCtx;
          break;
        }
        case "Perform": {
          const { args, options } = action;
          const h = findHandlers(action.key)(
            options && options.scope ? options.scope.programCtx : context
          )(this.onError);
          if (!h) return;
          const [handler, transformCtx] = h;
          const handlerAction = handler(...args, {
            transformCtx,
            programCtx: context,
          });
          const activatedHandlerCtx = {
            // 1. Make the activated handler returns to the *return transformation* parent,
            // and not to the *return transformation* directly (so it doesn't get transformed)
            prev: transformCtx!.prev,
            action: handlerAction,
          };
          this.context = activatedHandlerCtx;
          break;
        }
        case "Resume": {
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
  return(value: any, currCtx: Context) {
    const prev = currCtx && currCtx.prev;
    if (prev) {
      switch (prev.action.type) {
        case "Handler": {
          this.return(value, prev);
          break;
        }
        case "Chain": {
          this.context = {
            prev: prev.prev,
            action: prev.action.chainer(value),
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
// const _io = _effect("io");
// const withIo = _handler({
//   return: (value) => pure(() => value),
//   io: (thunk, k) => _resume(k, thunk()),
// });

// const Effect = {
//   map,
//   chain,
//   of: pure,
//   single: makeGeneratorDo(pure)(chain),
//   do: makeMultishotGeneratorDo(pure)(chain),
// };
// const eff = Effect.single;
// const _forEach = _effect("forEach");

// const _withForEach = _handler({
//   return: (val) => pure([val]),
//   forEach: (array, k) => {
//     const nextInstr = (newArr = []) => {
//       if (array.length === 0) {
//         return pure(newArr);
//       } else {
//         const first = array.shift();
//         return _resume(k, first).chain((a) => {
//           for (const item of a) {
//             newArr.push(item);
//           }
//           return nextInstr(newArr);
//         });
//       }
//     };
//     return nextInstr();
//   },
// });

// const _raise = _effect("error");
// const handleError = (handleError) =>
//   _handler({
//     error: (exn, k) => handleError(k, exn),
//   });
// const toEither = _handler({
//   return: (value) =>
//     pure({
//       type: "right",
//       value,
//     }),
//   error: (exn) =>
//     pure({
//       type: "left",
//       value: exn,
//     }),
// });
// const _waitFor = _effect("async");

// const withIoPromise = _handler({
//   return: (value) => pure(Promise.resolve(value)),
//   async: (iopromise, k) =>
//     _io(iopromise).chain((promise) =>
//       singleCallback((done) => {
//         promise
//           .then((value) => {
//             done({ success: true, value });
//           })
//           .catch((error) => {
//             done({ success: false, error });
//           });
//       }).chain((res) =>
//         res.success
//           ? _resume(k, res.value)
//           : options({
//               scope: k,
//             })(_raise(res.value)).chain((e) => _resume(k, e))
//       )
//     ),
// });
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
        action: toEither(withIoPromise(withIo(program))),
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

      return chain((value) => {
        trace.length = pos;
        /* recording the resolved value */
        trace[pos] = value;
        ctx.pos = pos + 1;
        /** replay */
        return step(value);
      })(ctx.effect);
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
  },
});
const run = (thunk) => _run(toAction(() => withUse(thunk)));
const io = (ioThunk) => perform(_io(ioThunk));
const waitFor = (ioPromise) => perform(_waitFor(ioPromise));
const forEach = (arr) => perform(_forEach(arr));
const withForEach = toModernHandler(_withForEach);
const raise = (err) => perform(_raise(err));
const print = effect("print");

const withPrint = handler({
  print(val, k) {
    io(() => console.log(val));
    return resume(k);
  },
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

run(main).then(console.log).catch(console.error);

module.exports = {
  flow,
  pipe,
  id,
  withForEach: _withForEach,
  eff,
  forEach: _forEach,
  run: _run,
  io: _io,
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
  Effect,
  toEither,
  waitFor: _waitFor,
  withIoPromise,
  raise: _raise,
  handleError,
};
