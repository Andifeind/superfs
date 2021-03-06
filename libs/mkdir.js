'use strict'

const fs = require('fs')
const path = require('path')

const mkdir = function (dir, done) {
  fs.access(dir, err => {
    if (!err) {
      return done()
    }

    let curDir = path.join(dir, '../')
    if (curDir === '/') {
      return done()
    }

    mkdir(curDir, err => {
      if (err) {
        return done(err)
      }

      fs.mkdir(dir, err => {
        done(err)
      })
    })
  })
}

module.exports = mkdir
