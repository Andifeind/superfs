'use strict'

const fs = require('fs')
const path = require('path')

const co = require('co')
const SuperFSFile = require('./file')
const FSTools = require('./FSTools')

class SuperFSDir {
  constructor (dirname) {
    if (/^\.\.?/.test(dirname)) {
      dirname = path.resolve(path.dirname(module.parent.parent.filename), dirname)
    }

    this.path = dirname
  }

  create () {
    return new Promise((resolve, reject) => {
      fs.lstat(this.path, (err, stat) => {
        if (err) {
          return reject(err)
        }

        resolve(Object.assign(this, {
          name: path.basename(this.path),
          dir: path.dirname(this.path),
          ext: path.extname(this.path).substr(1),
          isFile: stat.isFile(),
          isDir: stat.isDirectory(),
          isLink: stat.isSymbolicLink(),
          isBlockDevice: stat.isBlockDevice(),
          isCharDevice: stat.isCharacterDevice(),
          isFIFO: stat.isFIFO(),
          isSocket: stat.isSocket()
        }, stat))
      })
    })
  }

  /**
   * Reads a directory
   *
   * @method read
   * @param {string} [encoding=utf8] Changes encoding.
   *
   * @returns Returns a promise with an array of files und directories. Each item is either a FSFile or FSDir object
   * @arg {array} list Array of FSFile and FSDir objects
   */
  read (opts) {
    opts = Object.assign({
      encoding: 'utf8',
      recursive: false,
      relativePath: '',
      skipFiles: false,
      skipDirs: false,
      addParent: false,
      filter: null,
      ignore: null
    }, opts || {})

    const fileFilter = FSTools.createFileMatch(opts.filter)

    return co(function * () {
      const outFiles = []
      if (opts.addParent) {
        outFiles.push(yield this.create())
      }

      const ignoreReg = opts.ignore
        ? FSTools.createFileMatch(opts.ignore)
        : null

      let rawFiles = yield FSTools.readDir(this.path)

      if (ignoreReg) {
        rawFiles = rawFiles.filter((file) => {
          if (ignoreReg.test(file)) {
            return true
          }

          return false
        })
      }

      for (const file of rawFiles) {
        const filepath = path.join(this.path, file)
        const stat = yield FSTools.stat(filepath)

        if (stat.isDirectory()) {
          const dir = new SuperFSDir(filepath)
          yield dir.create()

          dir.relative = opts.relativePath ? `${opts.relativePath}/${dir.name}` : dir.name
          if (!opts.skipDirs && (!fileFilter || (fileFilter && fileFilter.test(dir.relative)))) {
            outFiles.push(dir)
          }

          if (opts.recursive) {
            const subFiles = yield dir.read(Object.assign({}, opts, {
              relativePath: opts.relativePath ? `${opts.relativePath}/${file}` : file,
              filter: opts.filter,
              addParent: false
            }))

            subFiles.forEach(s => {
              if (ignoreReg && ignoreReg.test(s.path)) {
                return
              }

              outFiles.push(s)
            })
          }
        } else {
          if (opts.skipFiles) {
            continue
          }

          if (fileFilter && !fileFilter.test(filepath)) {
            continue
          }

          const fl = new SuperFSFile(filepath, {
            encoding: opts.encoding
          })

          yield fl.create()
          fl.relative = opts.relativePath ? `${opts.relativePath}/${fl.name}` : fl.name
          outFiles.push(fl)
        }
      }

      return outFiles
    }.bind(this))
  }

  exists () {
    return new Promise((resolve, reject) => {
      fs.access(this.path, function (err) {
        if (err) {
          return resolve(false)
        }

        resolve(true)
      })
    })
  }

  mkdir (dir, opts) {
    return co(function * () {
      const dirs = FSTools.createPathArray(dir)

      for (const d of dirs) {
        if (yield FSTools.exists(d)) {
          continue
        }

        yield FSTools.createDir(d, opts)
      }
    })
  }

  copy (dest, opts) {
    if (opts === true) {
      opts = {
        recursive: true,
        overwrite: false
      }
    }

    opts = opts || {
      recursive: false,
      overwrite: false
    }

    return co(function * () {
      if (!(yield FSTools.exists(dest))) {
        yield this.mkdir(dest)
      }

      const files = yield this.read({
        recursive: true
      })

      for (const fl of files) {
        const destFile = path.join(dest, fl.relative)
        if (fl.isDir) {
          yield this.mkdir(destFile, opts.dirMode || fl.mode)
        } else {
          const data = yield FSTools.readFile(fl.path)
          const targetExists = yield FSTools.exists(destFile)
          fl.fileExists = targetExists
          fl.fileOverwritten = !!opts.overwrite
          if (!targetExists || opts.overwrite) {
            yield FSTools.writeFile(destFile, data, {
              mode: opts.fileMode || fl.mode
            })
          }
        }
      }

      // console.log('RETURN FILES', files)
      return files
    }.bind(this))
  }

  delete () {
    return co(function * () {
      const files = yield this.read({
        recursive: true
      })

      const sortedFiles = files.sort((a, b) => a.isDir ? 1 : -1)
      for (const fl of sortedFiles) {
        if (fl.isDir) {
          yield FSTools.removeDir(fl.path)
        } else {
          yield FSTools.removeFile(fl.path)
        }
      }

      return sortedFiles
    }.bind(this))
    // return new Promise((resolve, reject) => {
    //   this.read({
    //     recursive: true
    //   }).then((files) => {
    //     Promise.all(files.sort((a, b) => a.isDir ? 1 : -1).map((fl) => {
    //       return new Promise((innerResolve, innerReject) => {
    //         if (fl.isDir) {
    //           fs.rmdir(fl.path, (err) => {
    //             if (err) {
    //               throw err
    //             }
    //
    //             innerResolve(fl)
    //           })
    //         } else {
    //           fs.unlink(fl.path, (err, data) => {
    //             if (err) {
    //               throw err
    //             }
    //
    //             innerResolve(fl)
    //           })
    //         }
    //       })
    //     })).then(resolve).catch(reject)
    //   }).catch(reject)
    // })
  }

  watch (opts, fn) {
    if (typeof opts === 'function') {
      fn = opts
      opts = {}
    }

    return co(function * () {
      const dirs = yield this.read({
        recursive: true,
        skipFiles: true,
        addParent: true
      })

      const ignoreReg = opts.ignore
        ? FSTools.createFileMatch(opts.ignore)
        : null

      for (const fl of dirs) {
        if (ignoreReg && ignoreReg.test(fl.path)) {
          continue
        }

        fs.watch(fl.path, function fileChangeHandler (eventName, fileName) {
          if (this.lock) {
            return
          }
          this.lock = true
          fl.changeMode = eventName
          fl.changedFile = fileName
          fn(fl)
          setTimeout(() => {
            this.lock = false
          }, 500)
        })
      }

      return dirs
    }.bind(this))
  }
}

module.exports = SuperFSDir
