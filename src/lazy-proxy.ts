import { LazyProperty } from './lazy-property';
import { FunctionProxyResolver as FPResolver } from './function-proxy-resolver';
import { isObject, DefaultPropertyDescriptors } from './utils';

/** Lazy initializer proxy factory */
export namespace LazyProxy {
  // If arrow function has been transpiled to full function object,
  // enforce to use the constructor handler in order to correctly follow the rules.
  const forceConstructor = !!(() => {}).prototype;
  const wrappers = new WeakMap<object, LazyHandler<object>>();

  class LazyHandler<T extends object> implements ProxyHandler<T> {
    // Rule breaking resolver: Apply trap needs the dummy object be a callable function.
    // Arrow function is safest as it does not have any extra properties.
    protected static readonly dummy: object = () => {
      throw new Error('This should not be called');
    }

    private init: () => T;

    public get dummy() {
      return LazyHandler.dummy;
    }

    @LazyProperty
    public get source(): T {
      const result = Object(this.init());
      delete this.init; // Release reference
      return result;
    }

    public constructor(init: () => T) {
      this.init = init;
    }

    public has(_: T, key: PropertyKey) {
      return Reflect.has(this.source, key);
    }

    public get(_: T, key: PropertyKey, receiver: any) {
      return FPResolver.wrap(Reflect.get(this.source, key, receiver));
    }

    public set(_: T, key: PropertyKey, value: any, receiver: any) {
      return Reflect.set(this.source, key, FPResolver.unwrap(value), receiver);
    }

    public deleteProperty(_: T, key: PropertyKey) {
      return Reflect.deleteProperty(this.source, key);
    }

    public ownKeys(_: T) {
      return Reflect.ownKeys(this.source);
    }

    public getOwnPropertyDescriptor(_: T, key: PropertyKey) {
      const attributes = Reflect.getOwnPropertyDescriptor(this.source, key);
      // Rule breaking resolver: Let all properties looks like configurable.
      if(attributes)
        attributes.configurable = true;
      return attributes ||
        // Tell some lie: If not exists and proxified object is non extensible,
        // treat this property as exists, undefined, configurable but read only.
        (!Reflect.isExtensible(this.source) ?
          DefaultPropertyDescriptors.empty :
          undefined);
    }

    public defineProperty(_: T, key: PropertyKey, attributes: PropertyDescriptor) {
      // Rule breaking resolver: Don't allow to seal any properties.
      if(!attributes.configurable)
        return false;
      if(attributes.value)
        attributes.value = FPResolver.unwrap(attributes.value);
      return Reflect.defineProperty(this.source, key, attributes);
    }

    public getPrototypeOf(_: T) {
      return Reflect.getPrototypeOf(this.source);
    }

    public setPrototypeOf(_: T, proto: any) {
      return Reflect.setPrototypeOf(this.source, FPResolver.resolve(proto));
    }

    public preventExtensions(_: T) {
      // Rule breaking resolver: Don't allow to seal the proxified object.
      return false;
    }

    public apply(_: T, thisArg: any, args: ArrayLike<any>) {
      return Reflect.apply(
        this.source as Function, FPResolver.resolve(thisArg), FPResolver.resolveAll(args),
      );
    }
  }

  /** Alternative handler with constructor function support */
  class ConstructorLazyHandler<T extends object> extends LazyHandler<T> {
    // Rule breaking resolver: We need a fully crafted function as dummy object
    // to use with construct traps.
    protected static readonly dummy: object = function() {
      throw new Error('This should not be called');
    }

    public get dummy() {
      return ConstructorLazyHandler.dummy;
    }

    public getOwnPropertyDescriptor(target: T, key: PropertyKey) {
      const result = super.getOwnPropertyDescriptor(target, key);
      if(result) return result;
      // Rule breaking resolver: If dummy property is exists but non-configurable,
      // remove original property's value, getter and setter then return.
      const sealed = getDescriptorIfSealed(target, key);
      if(sealed) {
        delete sealed.value;
        delete sealed.get;
        delete sealed.set;
      }
      return sealed;
    }

    public ownKeys(target: T) {
      const keys = super.ownKeys(target);
      const keySet = new Set(keys);
      // Rule breaking resolver: Union all dummy properties which non-configurable
      for(const key of Reflect.ownKeys(target))
        if(getDescriptorIfSealed(target, key) && !keySet.has(key))
          keys.push(key);
      return keys;
    }

    public construct(_: T, args: ArrayLike<any>, newTarget: any) {
      return Reflect.construct(
        this.source as Function, FPResolver.resolveAll(args), newTarget,
      );
    }
  }

  function getDescriptorIfSealed(target: object, key: PropertyKey) {
    const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
    return descriptor && !descriptor.configurable ? descriptor : undefined;
  }

  /**
   * Create a proxy object which loosely reflects to the target object
   * of a delayed (lazy) initializer.
   * @param init The lazy initializer which returns the object.
   * @param isConstructor Whether the target object will be a constructor and
   * the proxy will use as constructor directly or not. This will use a alternative flow
   * with some minor drawbacks to provide constructor support.
   * @example
   * ```javascript
   * const somethingExpensive = LazyProxy.create(() => {
   *   // Some heavy stuffs...
   *   return someHeavyObject;
   * });
   * 
   * // You may treat the object is loosely equals to the initialized object itself.
   * const someValue = somethingExpensive.someValue();
   * ```
   */
  export function create<T extends object>(init: () => T, isConstructor?: boolean): T;
  export function create<T>(init: () => T, isConstructor?: boolean): T & object;
  export function create(init: () => object, isConstructor?: boolean) {
    const handler: LazyHandler<object> = (isConstructor || forceConstructor) ?
      new ConstructorLazyHandler(init) :
      new LazyHandler(init);
    const wrapper = new Proxy(handler.dummy, handler);
    wrappers.set(wrapper, handler);
    return wrapper;
  }
  
  /**
   * Get the target source object of a proxy. Will returns itself if not found.
   * If the initializer is not yet resolved, it will resolves immediately.
   * @param maybeProxy The wrapped proxy.
   */
  export function getSource<T>(maybeProxy: T) {
    if(isObject(maybeProxy)) {
      const handler = wrappers.get(maybeProxy);
      if(handler)
        return handler.source as T & object;
    }
    return maybeProxy;
  }

  FPResolver.register(getSource);
}
