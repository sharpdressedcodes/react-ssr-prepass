import React, {
  Fragment,
  Component,
  createElement,
  createContext,
  useContext,
  useState,
  useMemo,
  useRef
} from 'react'

import renderPrepass from '..'

describe('renderPrepass', () => {
  describe('event loop yielding', () => {
    it('yields to the event loop when work is taking too long', () => {
      const Inner = jest.fn(() => null)

      const Outer = () => {
        const start = Date.now()
        while (Date.now() - start < 40) {}
        return <Inner />
      }

      const render$ = renderPrepass(<Outer />)

      expect(Inner).toHaveBeenCalledTimes(0)

      setImmediate(() => {
        setImmediate(() => {
          expect(Inner).toHaveBeenCalledTimes(1)
        })
      })

      return render$.then(() => {
        expect(Inner).toHaveBeenCalledTimes(1)
      })
    })

    it('rejects promise after getting of exception inside', () => {
      const exception = new TypeError('Something went wrong')

      const Inner = jest.fn(() => {
        throw exception
      })

      const Outer = () => {
        const start = Date.now()
        while (Date.now() - start < 40) {}
        return <Inner />
      }

      const render$ = renderPrepass(<Outer />)

      return render$.catch((error) => {
        expect(Inner).toHaveBeenCalledTimes(1)
        expect(error).toBe(exception)
      })
    })

    it('preserves the correct legacy context values across yields', () => {
      let called = false
      const Inner = (_, context) => {
        expect(context.test).toBe(123)
        called = true
        return null
      }

      const Wait = (props) => {
        const start = Date.now()
        while (Date.now() - start < 21) {}
        return props.children
      }

      class Outer extends Component {
        getChildContext() {
          return { test: 123 }
        }

        render() {
          return (
            <Wait>
              <Wait>
                <Inner />
              </Wait>
            </Wait>
          )
        }
      }

      Inner.contextTypes = { test: null }
      Outer.childContextTypes = { test: null }

      const render$ = renderPrepass(<Outer />)
      expect(called).toBe(false)
      return render$.then(() => {
        expect(called).toBe(true)
      })
    })

    it('preserves the correct context values across yields', () => {
      const Context = createContext(null)

      let called = false
      const Inner = () => {
        const value = useContext(Context)
        expect(value).toBe(123)
        called = true
        return null
      }

      const Wait = () => {
        const start = Date.now()
        while (Date.now() - start < 21) {}
        return <Inner />
      }

      const Outer = () => {
        return (
          <Context.Provider value={123}>
            <Wait />
          </Context.Provider>
        )
      }

      const render$ = renderPrepass(<Outer />)
      expect(called).toBe(false)
      return render$.then(() => {
        expect(called).toBe(true)
      })
    })

    it('does not yields when work is below the threshold', () => {
      const Inner = jest.fn(() => null)
      const Outer = () => <Inner />
      const render$ = renderPrepass(<Outer />)

      expect(Inner).toHaveBeenCalledTimes(1)
    })
  })

  describe('function components', () => {
    it('supports suspending subtrees', () => {
      const value = {}
      const getValue = jest
        .fn()
        .mockImplementationOnce(() => {
          throw Promise.resolve()
        })
        .mockImplementationOnce(() => value)

      const Inner = jest.fn((props) => {
        expect(props.value).toBe(value)
        // We expect useState to work across suspense
        expect(props.state).toBe('test')
      })

      const Outer = jest.fn(() => {
        const [state] = useState('test')
        expect(state).toBe('test')
        return <Inner value={getValue()} state={state} />
      })

      const Wrapper = jest.fn(() => <Outer />)
      const render$ = renderPrepass(<Wrapper />)

      // We've synchronously walked the tree and expect a suspense
      // queue to have now built up
      expect(getValue).toHaveBeenCalledTimes(1)
      expect(Inner).not.toHaveBeenCalled()
      expect(Outer).toHaveBeenCalledTimes(1)

      return render$.then(() => {
        // After suspense we expect a rerender of the suspended subtree to
        // have happened
        expect(getValue).toHaveBeenCalledTimes(2)
        expect(Outer).toHaveBeenCalledTimes(2)
        expect(Inner).toHaveBeenCalledTimes(1)

        // Since only the subtree rerenders, we expect the Wrapper to have
        // only renderer once
        expect(Wrapper).toHaveBeenCalledTimes(1)
      })
    })

    it('preserves state correctly across suspensions', () => {
      const getValue = jest
        .fn()
        .mockImplementationOnce(() => {
          throw Promise.resolve()
        })
        .mockImplementation(() => 'test')

      const Inner = jest.fn((props) => {
        expect(props.value).toBe('test')
        expect(props.state).toBe('test')
      })

      const Outer = jest.fn(() => {
        const [state, setState] = useState('default')

        const memoedA = useMemo(() => state, [state])
        expect(memoedA).toBe(state)

        // This is to test changing dependency arrays
        const memoedB = useMemo(
          () => state,
          state === 'default' ? null : [state]
        )
        expect(memoedB).toBe(state)

        const ref = useRef('initial')
        expect(ref.current).toBe('initial')

        const value = getValue()
        setState(() => value)

        return <Inner value={value} state={state} />
      })

      return renderPrepass(<Outer />).then(() => {
        expect(Outer).toHaveBeenCalledTimes(3 * 3 * 3 /* welp */)
        expect(Inner).toHaveBeenCalledTimes(2)
      })
    })

    it("handles suspenses thrown in useState's initialState initialiser", () => {
      const getValue = jest
        .fn()
        .mockImplementationOnce(() => {
          throw Promise.resolve()
        })
        .mockImplementation(() => 'test')

      const Inner = jest.fn((props) => {
        expect(props.state).toBe('test')
      })

      const Outer = jest.fn(() => {
        const [state] = useState(() => {
          // This will trigger suspense:
          return getValue()
        })

        return <Inner state={state} />
      })

      return renderPrepass(<Outer />).then(() => {
        expect(Outer).toHaveBeenCalled()
        expect(Inner).toHaveBeenCalled()
      })
    })

    it('ignores thrown non-promises', () => {
      const Outer = () => {
        throw new Error('test')
      }
      const render$ = renderPrepass(<Outer />)
      expect(render$).rejects.toThrow('test')
    })

    it('supports promise visitors', () => {
      const Inner = jest.fn(() => null)
      const Outer = jest.fn(() => <Inner />)

      const visitor = jest.fn((element) => {
        if (element.type === Inner) return Promise.resolve()
      })

      const render$ = renderPrepass(<Outer />, visitor)

      // We expect the visitor to have returned a promise
      // which is now queued
      expect(Inner).not.toHaveBeenCalled()
      expect(Outer).toHaveBeenCalledTimes(1)

      return render$.then(() => {
        // After suspense we expect Inner to then have renderer
        // and the visitor to have been called for both elements
        expect(Outer).toHaveBeenCalledTimes(1)
        expect(Inner).toHaveBeenCalledTimes(1)
        expect(visitor).toHaveBeenCalledTimes(2)
      })
    })
  })

  describe('class components', () => {
    it('supports suspending subtrees', () => {
      const value = {}
      const getValue = jest
        .fn()
        .mockImplementationOnce(() => {
          throw Promise.resolve()
        })
        .mockImplementationOnce(() => value)

      const Inner = jest.fn((props) => expect(props.value).toBe(value))

      class Outer extends Component {
        render() {
          return <Inner value={getValue()} />
        }
      }

      const render$ = renderPrepass(<Outer />)

      // We've synchronously walked the tree and expect a suspense
      // queue to have now built up
      expect(getValue).toHaveBeenCalledTimes(1)
      expect(Inner).not.toHaveBeenCalled()

      return render$.then(() => {
        // After suspense we expect a rerender of the suspended subtree to
        // have happened
        expect(getValue).toHaveBeenCalledTimes(2)
        expect(Inner).toHaveBeenCalledTimes(1)
      })
    })

    it('ignores thrown non-promises', () => {
      class Outer extends Component {
        render() {
          throw new Error('test')
        }
      }

      const render$ = renderPrepass(<Outer />)
      expect(render$).rejects.toThrow('test')
    })

    it('supports promise visitors', () => {
      const Inner = jest.fn(() => null)

      class Outer extends Component {
        render() {
          return <Inner />
        }
      }

      const visitor = jest.fn((element, instance) => {
        if (element.type === Outer) {
          expect(instance).toEqual(expect.any(Outer))
          return Promise.resolve()
        }
      })

      const render$ = renderPrepass(<Outer />, visitor)

      // We expect the visitor to have returned a promise
      // which is now queued
      expect(Inner).not.toHaveBeenCalled()

      return render$.then(() => {
        // After suspense we expect Inner to then have renderer
        // and the visitor to have been called for both elements
        expect(Inner).toHaveBeenCalledTimes(1)
        expect(visitor).toHaveBeenCalledTimes(2)
      })
    })

    it('supports unconventional updates via the visitor', () => {
      const newState = { value: 'test' }

      class Outer extends Component {
        constructor() {
          super()
          this.state = { value: 'initial' }
        }

        render() {
          expect(this.state).toEqual(newState)
          return null
        }
      }

      const visitor = jest.fn((element, instance) => {
        if (element.type === Outer) {
          expect(instance.updater.isMounted(instance)).toBe(false)
          instance.updater.enqueueForceUpdate(instance)
          instance.updater.enqueueReplaceState(instance, newState)
        }
      })

      renderPrepass(<Outer />, visitor)
      expect(visitor).toHaveBeenCalledTimes(1)
    })
  })

  describe('lazy components', () => {
    it('supports resolving lazy components', () => {
      const value = {}
      const Inner = jest.fn((props) => expect(props.value).toBe(value))
      const loadInner = jest.fn().mockResolvedValueOnce(Inner)

      const Outer = React.lazy(loadInner)
      // Initially React sets the lazy component's status to -1
      expect(Outer._payload._status).toBe(-1 /* INITIAL */)

      const render$ = renderPrepass(<Outer value={value} />, undefined, true)

      // We've synchronously walked the tree and expect a suspense
      // queue to have now built up
      expect(Inner).not.toHaveBeenCalled()
      expect(loadInner).toHaveBeenCalledTimes(1)

      // The lazy component's state should be updated with some initial
      // progress
      expect(Outer._payload._status).toBe(0 /* PENDING */)

      return render$.then(() => {
        // Afterwards we can expect Inner to have loaded and rendered
        expect(Inner).toHaveBeenCalledTimes(1)

        // The lazy component's state should reflect this
        expect(Outer._payload._status).toBe(1 /* SUCCESSFUL */)
      })
    })

    it('supports resolving ES exported components', () => {
      const Inner = jest.fn(() => null)
      const loadInner = jest.fn().mockResolvedValueOnce({ default: Inner })
      const Outer = React.lazy(loadInner)
      const render$ = renderPrepass(<Outer />, undefined, true)

      expect(Inner).not.toHaveBeenCalled()
      expect(loadInner).toHaveBeenCalledTimes(1)
      expect(Outer._payload._status).toBe(0 /* PENDING */)

      return render$.then(() => {
        expect(Inner).toHaveBeenCalledTimes(1)
        expect(Outer._payload._status).toBe(1 /* SUCCESSFUL */)
      })
    })

    it('supports skipping invalid components', () => {
      const loadInner = jest.fn().mockResolvedValueOnce({})
      const Outer = React.lazy(loadInner)
      const render$ = renderPrepass(<Outer />, undefined, true)

      expect(loadInner).toHaveBeenCalledTimes(1)
      expect(Outer._payload._status).toBe(0 /* PENDING */)

      return render$.then(() => {
        expect(Outer._payload._status).toBe(2 /* FAILED */)
      })
    })

    it('supports rendering previously resolved lazy components', () => {
      const Inner = jest.fn(() => null)
      const loadInner = jest.fn().mockResolvedValueOnce(Inner)
      const Outer = React.lazy(loadInner)

      Outer._payload._status = 1 /* SUCCESSFUL */
      Outer._payload._result = Inner /* SUCCESSFUL */

      renderPrepass(<Outer />, undefined, true)

      expect(loadInner).toHaveBeenCalledTimes(0)
      expect(Inner).toHaveBeenCalled()
    })
  })

  it('correctly tracks context values across subtress and suspenses', () => {
    const Context = createContext('default')
    let hasSuspended = false

    const TestA = jest.fn(() => {
      expect(useContext(Context)).toBe('a')
      return null
    })

    const TestB = jest.fn(() => {
      expect(useContext(Context)).toBe('b')
      return null
    })

    const TestC = jest.fn(() => {
      expect(useContext(Context)).toBe('c')
      if (!hasSuspended) {
        throw Promise.resolve().then(() => (hasSuspended = true))
      }

      return null
    })

    const Wrapper = () => {
      expect(useContext(Context)).toBe('default')

      return (
        <Fragment>
          <Context.Provider value="a">
            <TestA />
          </Context.Provider>
          <Context.Provider value="b">
            <TestB />
          </Context.Provider>
          <Context.Provider value="c">
            <TestC />
          </Context.Provider>
        </Fragment>
      )
    }

    const render$ = renderPrepass(<Wrapper />)
    expect(TestC).toHaveBeenCalledTimes(1)

    return render$.then(() => {
      expect(TestA).toHaveBeenCalledTimes(1)
      expect(TestB).toHaveBeenCalledTimes(1)
      expect(TestC).toHaveBeenCalledTimes(2)
    })
  })

  it('correctly tracks legacy context values across subtress and suspenses', () => {
    let hasSuspended = false

    class Provider extends Component {
      getChildContext() {
        return { value: this.props.value }
      }

      render() {
        return this.props.children
      }
    }

    Provider.childContextTypes = { value: null }

    class TestA extends Component {
      render() {
        expect(this.context.value).toBe('a')
        return null
      }
    }

    class TestB extends Component {
      render() {
        expect(this.context.value).toBe('b')
        if (!hasSuspended) {
          throw Promise.resolve().then(() => (hasSuspended = true))
        }

        return null
      }
    }

    TestA.contextTypes = { value: null }
    TestB.contextTypes = { value: null }

    const Wrapper = () => (
      <Fragment>
        <Provider value="a">
          <TestA />
        </Provider>
        <Provider value="b">
          <TestB />
        </Provider>
      </Fragment>
    )

    return renderPrepass(<Wrapper />).then(() => {
      expect(hasSuspended).toBe(true)
    })
  })
})
