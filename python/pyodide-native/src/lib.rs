use pyo3::prelude::*;
use std::path::PathBuf;
use std::sync::Mutex;
use wasmer::{Engine, FunctionEnv, Instance, Memory, Module, Store};
use wasmer_compiler_llvm::LLVM;
use wasmer_emscripten::{generate_emscripten_env, EmEnv, EmscriptenGlobals};

struct PyodideInner {
    store: Store,
    #[allow(dead_code)]
    instance: Instance,
    memory: Memory,
}

#[pyclass]
struct PyodideRuntime {
    inner: Mutex<Option<PyodideInner>>,
    wasm_path: PathBuf,
}

#[pymethods]
impl PyodideRuntime {
    #[new]
    fn new(wasm_path: &str) -> PyResult<Self> {
        Ok(Self {
            inner: Mutex::new(None),
            wasm_path: PathBuf::from(wasm_path),
        })
    }

    /// Boot the Pyodide WASM module. Returns status string.
    fn boot(&self) -> PyResult<String> {
        let compiler = LLVM::default();
        let mut store = Store::new(compiler);
        let module = Module::from_file(&store, &self.wasm_path).map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Load WASM: {e}"))
        })?;

        // Create the Emscripten environment.
        let env = FunctionEnv::new(&mut store, EmEnv::new());
        let mut globals = EmscriptenGlobals::new(&mut store, &env, &module).map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("EmscriptenGlobals: {e}"))
        })?;

        let import_object = generate_emscripten_env(&mut store, &env, &mut globals);
        let instance = Instance::new(&mut store, &module, &import_object).map_err(|e| {
            pyo3::exceptions::PyRuntimeError::new_err(format!("Instantiate: {e}"))
        })?;

        let memory = instance
            .exports
            .get_memory("memory")
            .map_err(|e| pyo3::exceptions::PyRuntimeError::new_err(format!("No memory: {e}")))?
            .clone();

        let mem_size = memory.view(&store).data_size();

        *self.inner.lock().unwrap() = Some(PyodideInner {
            store,
            instance,
            memory,
        });

        Ok(format!("Booted, memory: {} bytes", mem_size))
    }

    /// Get the memory base pointer as an integer (for mmap from Python via ctypes).
    fn memory_ptr(&self) -> PyResult<u64> {
        let guard = self.inner.lock().unwrap();
        let inner = guard
            .as_ref()
            .ok_or_else(|| pyo3::exceptions::PyRuntimeError::new_err("Not booted"))?;
        let view = inner.memory.view(&inner.store);
        Ok(view.data_ptr() as u64)
    }

    /// Get the memory size in bytes.
    fn memory_len(&self) -> PyResult<u64> {
        let guard = self.inner.lock().unwrap();
        let inner = guard
            .as_ref()
            .ok_or_else(|| pyo3::exceptions::PyRuntimeError::new_err("Not booted"))?;
        Ok(inner.memory.view(&inner.store).data_size() as u64)
    }
}

#[pymodule]
fn pyodide_native(m: &Bound<'_, PyModule>) -> PyResult<()> {
    m.add_class::<PyodideRuntime>()?;
    Ok(())
}
