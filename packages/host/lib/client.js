/* ===== qrcode-generator-2.0.4.js（随包内联；MIT，Copyright (c) 2009 Kazuhiko Arase）===== */
globalThis.__DSHM_QR_FACTORY__ = function () {
//---------------------------------------------------------------------
//
// QR Code Generator for JavaScript
//
// Copyright (c) 2009 Kazuhiko Arase
//
// URL: http://www.d-project.com/
//
// Licensed under the MIT license:
//  http://www.opensource.org/licenses/mit-license.php
//
// The word 'QR Code' is registered trademark of
// DENSO WAVE INCORPORATED
//  http://www.denso-wave.com/qrcode/faqpatent-e.html
//
//---------------------------------------------------------------------

var qrcode = function() {

  //---------------------------------------------------------------------
  // qrcode
  //---------------------------------------------------------------------

  /**
   * qrcode
   * @param typeNumber 1 to 40
   * @param errorCorrectionLevel 'L','M','Q','H'
   */
  var qrcode = function(typeNumber, errorCorrectionLevel) {

    var PAD0 = 0xEC;
    var PAD1 = 0x11;

    var _typeNumber = typeNumber;
    var _errorCorrectionLevel = QRErrorCorrectionLevel[errorCorrectionLevel];
    var _modules = null;
    var _moduleCount = 0;
    var _dataCache = null;
    var _dataList = [];

    var _this = {};

    var makeImpl = function(test, maskPattern) {

      _moduleCount = _typeNumber * 4 + 17;
      _modules = function(moduleCount) {
        var modules = new Array(moduleCount);
        for (var row = 0; row < moduleCount; row += 1) {
          modules[row] = new Array(moduleCount);
          for (var col = 0; col < moduleCount; col += 1) {
            modules[row][col] = null;
          }
        }
        return modules;
      }(_moduleCount);

      setupPositionProbePattern(0, 0);
      setupPositionProbePattern(_moduleCount - 7, 0);
      setupPositionProbePattern(0, _moduleCount - 7);
      setupPositionAdjustPattern();
      setupTimingPattern();
      setupTypeInfo(test, maskPattern);

      if (_typeNumber >= 7) {
        setupTypeNumber(test);
      }

      if (_dataCache == null) {
        _dataCache = createData(_typeNumber, _errorCorrectionLevel, _dataList);
      }

      mapData(_dataCache, maskPattern);
    };

    var setupPositionProbePattern = function(row, col) {

      for (var r = -1; r <= 7; r += 1) {

        if (row + r <= -1 || _moduleCount <= row + r) continue;

        for (var c = -1; c <= 7; c += 1) {

          if (col + c <= -1 || _moduleCount <= col + c) continue;

          if ( (0 <= r && r <= 6 && (c == 0 || c == 6) )
              || (0 <= c && c <= 6 && (r == 0 || r == 6) )
              || (2 <= r && r <= 4 && 2 <= c && c <= 4) ) {
            _modules[row + r][col + c] = true;
          } else {
            _modules[row + r][col + c] = false;
          }
        }
      }
    };

    var getBestMaskPattern = function() {

      var minLostPoint = 0;
      var pattern = 0;

      for (var i = 0; i < 8; i += 1) {

        makeImpl(true, i);

        var lostPoint = QRUtil.getLostPoint(_this);

        if (i == 0 || minLostPoint > lostPoint) {
          minLostPoint = lostPoint;
          pattern = i;
        }
      }

      return pattern;
    };

    var setupTimingPattern = function() {

      for (var r = 8; r < _moduleCount - 8; r += 1) {
        if (_modules[r][6] != null) {
          continue;
        }
        _modules[r][6] = (r % 2 == 0);
      }

      for (var c = 8; c < _moduleCount - 8; c += 1) {
        if (_modules[6][c] != null) {
          continue;
        }
        _modules[6][c] = (c % 2 == 0);
      }
    };

    var setupPositionAdjustPattern = function() {

      var pos = QRUtil.getPatternPosition(_typeNumber);

      for (var i = 0; i < pos.length; i += 1) {

        for (var j = 0; j < pos.length; j += 1) {

          var row = pos[i];
          var col = pos[j];

          if (_modules[row][col] != null) {
            continue;
          }

          for (var r = -2; r <= 2; r += 1) {

            for (var c = -2; c <= 2; c += 1) {

              if (r == -2 || r == 2 || c == -2 || c == 2
                  || (r == 0 && c == 0) ) {
                _modules[row + r][col + c] = true;
              } else {
                _modules[row + r][col + c] = false;
              }
            }
          }
        }
      }
    };

    var setupTypeNumber = function(test) {

      var bits = QRUtil.getBCHTypeNumber(_typeNumber);

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[Math.floor(i / 3)][i % 3 + _moduleCount - 8 - 3] = mod;
      }

      for (var i = 0; i < 18; i += 1) {
        var mod = (!test && ( (bits >> i) & 1) == 1);
        _modules[i % 3 + _moduleCount - 8 - 3][Math.floor(i / 3)] = mod;
      }
    };

    var setupTypeInfo = function(test, maskPattern) {

      var data = (_errorCorrectionLevel << 3) | maskPattern;
      var bits = QRUtil.getBCHTypeInfo(data);

      // vertical
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 6) {
          _modules[i][8] = mod;
        } else if (i < 8) {
          _modules[i + 1][8] = mod;
        } else {
          _modules[_moduleCount - 15 + i][8] = mod;
        }
      }

      // horizontal
      for (var i = 0; i < 15; i += 1) {

        var mod = (!test && ( (bits >> i) & 1) == 1);

        if (i < 8) {
          _modules[8][_moduleCount - i - 1] = mod;
        } else if (i < 9) {
          _modules[8][15 - i - 1 + 1] = mod;
        } else {
          _modules[8][15 - i - 1] = mod;
        }
      }

      // fixed module
      _modules[_moduleCount - 8][8] = (!test);
    };

    var mapData = function(data, maskPattern) {

      var inc = -1;
      var row = _moduleCount - 1;
      var bitIndex = 7;
      var byteIndex = 0;
      var maskFunc = QRUtil.getMaskFunction(maskPattern);

      for (var col = _moduleCount - 1; col > 0; col -= 2) {

        if (col == 6) col -= 1;

        while (true) {

          for (var c = 0; c < 2; c += 1) {

            if (_modules[row][col - c] == null) {

              var dark = false;

              if (byteIndex < data.length) {
                dark = ( ( (data[byteIndex] >>> bitIndex) & 1) == 1);
              }

              var mask = maskFunc(row, col - c);

              if (mask) {
                dark = !dark;
              }

              _modules[row][col - c] = dark;
              bitIndex -= 1;

              if (bitIndex == -1) {
                byteIndex += 1;
                bitIndex = 7;
              }
            }
          }

          row += inc;

          if (row < 0 || _moduleCount <= row) {
            row -= inc;
            inc = -inc;
            break;
          }
        }
      }
    };

    var createBytes = function(buffer, rsBlocks) {

      var offset = 0;

      var maxDcCount = 0;
      var maxEcCount = 0;

      var dcdata = new Array(rsBlocks.length);
      var ecdata = new Array(rsBlocks.length);

      for (var r = 0; r < rsBlocks.length; r += 1) {

        var dcCount = rsBlocks[r].dataCount;
        var ecCount = rsBlocks[r].totalCount - dcCount;

        maxDcCount = Math.max(maxDcCount, dcCount);
        maxEcCount = Math.max(maxEcCount, ecCount);

        dcdata[r] = new Array(dcCount);

        for (var i = 0; i < dcdata[r].length; i += 1) {
          dcdata[r][i] = 0xff & buffer.getBuffer()[i + offset];
        }
        offset += dcCount;

        var rsPoly = QRUtil.getErrorCorrectPolynomial(ecCount);
        var rawPoly = qrPolynomial(dcdata[r], rsPoly.getLength() - 1);

        var modPoly = rawPoly.mod(rsPoly);
        ecdata[r] = new Array(rsPoly.getLength() - 1);
        for (var i = 0; i < ecdata[r].length; i += 1) {
          var modIndex = i + modPoly.getLength() - ecdata[r].length;
          ecdata[r][i] = (modIndex >= 0)? modPoly.getAt(modIndex) : 0;
        }
      }

      var totalCodeCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalCodeCount += rsBlocks[i].totalCount;
      }

      var data = new Array(totalCodeCount);
      var index = 0;

      for (var i = 0; i < maxDcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < dcdata[r].length) {
            data[index] = dcdata[r][i];
            index += 1;
          }
        }
      }

      for (var i = 0; i < maxEcCount; i += 1) {
        for (var r = 0; r < rsBlocks.length; r += 1) {
          if (i < ecdata[r].length) {
            data[index] = ecdata[r][i];
            index += 1;
          }
        }
      }

      return data;
    };

    var createData = function(typeNumber, errorCorrectionLevel, dataList) {

      var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, errorCorrectionLevel);

      var buffer = qrBitBuffer();

      for (var i = 0; i < dataList.length; i += 1) {
        var data = dataList[i];
        buffer.put(data.getMode(), 4);
        buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
        data.write(buffer);
      }

      // calc num max data.
      var totalDataCount = 0;
      for (var i = 0; i < rsBlocks.length; i += 1) {
        totalDataCount += rsBlocks[i].dataCount;
      }

      if (buffer.getLengthInBits() > totalDataCount * 8) {
        throw 'code length overflow. ('
          + buffer.getLengthInBits()
          + '>'
          + totalDataCount * 8
          + ')';
      }

      // end code
      if (buffer.getLengthInBits() + 4 <= totalDataCount * 8) {
        buffer.put(0, 4);
      }

      // padding
      while (buffer.getLengthInBits() % 8 != 0) {
        buffer.putBit(false);
      }

      // padding
      while (true) {

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD0, 8);

        if (buffer.getLengthInBits() >= totalDataCount * 8) {
          break;
        }
        buffer.put(PAD1, 8);
      }

      return createBytes(buffer, rsBlocks);
    };

    _this.addData = function(data, mode) {

      mode = mode || 'Byte';

      var newData = null;

      switch(mode) {
      case 'Numeric' :
        newData = qrNumber(data);
        break;
      case 'Alphanumeric' :
        newData = qrAlphaNum(data);
        break;
      case 'Byte' :
        newData = qr8BitByte(data);
        break;
      case 'Kanji' :
        newData = qrKanji(data);
        break;
      default :
        throw 'mode:' + mode;
      }

      _dataList.push(newData);
      _dataCache = null;
    };

    _this.isDark = function(row, col) {
      if (row < 0 || _moduleCount <= row || col < 0 || _moduleCount <= col) {
        throw row + ',' + col;
      }
      return _modules[row][col];
    };

    _this.getModuleCount = function() {
      return _moduleCount;
    };

    _this.make = function() {
      if (_typeNumber < 1) {
        var typeNumber = 1;

        for (; typeNumber < 40; typeNumber++) {
          var rsBlocks = QRRSBlock.getRSBlocks(typeNumber, _errorCorrectionLevel);
          var buffer = qrBitBuffer();

          for (var i = 0; i < _dataList.length; i++) {
            var data = _dataList[i];
            buffer.put(data.getMode(), 4);
            buffer.put(data.getLength(), QRUtil.getLengthInBits(data.getMode(), typeNumber) );
            data.write(buffer);
          }

          var totalDataCount = 0;
          for (var i = 0; i < rsBlocks.length; i++) {
            totalDataCount += rsBlocks[i].dataCount;
          }

          if (buffer.getLengthInBits() <= totalDataCount * 8) {
            break;
          }
        }

        _typeNumber = typeNumber;
      }

      makeImpl(false, getBestMaskPattern() );
    };

    _this.createTableTag = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var qrHtml = '';

      qrHtml += '<table style="';
      qrHtml += ' border-width: 0px; border-style: none;';
      qrHtml += ' border-collapse: collapse;';
      qrHtml += ' padding: 0px; margin: ' + margin + 'px;';
      qrHtml += '">';
      qrHtml += '<tbody>';

      for (var r = 0; r < _this.getModuleCount(); r += 1) {

        qrHtml += '<tr>';

        for (var c = 0; c < _this.getModuleCount(); c += 1) {
          qrHtml += '<td style="';
          qrHtml += ' border-width: 0px; border-style: none;';
          qrHtml += ' border-collapse: collapse;';
          qrHtml += ' padding: 0px; margin: 0px;';
          qrHtml += ' width: ' + cellSize + 'px;';
          qrHtml += ' height: ' + cellSize + 'px;';
          qrHtml += ' background-color: ';
          qrHtml += _this.isDark(r, c)? '#000000' : '#ffffff';
          qrHtml += ';';
          qrHtml += '"/>';
        }

        qrHtml += '</tr>';
      }

      qrHtml += '</tbody>';
      qrHtml += '</table>';

      return qrHtml;
    };

    _this.createSvgTag = function(cellSize, margin, alt, title) {

      var opts = {};
      if (typeof arguments[0] == 'object') {
        // Called by options.
        opts = arguments[0];
        // overwrite cellSize and margin.
        cellSize = opts.cellSize;
        margin = opts.margin;
        alt = opts.alt;
        title = opts.title;
      }

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      // Compose alt property surrogate
      alt = (typeof alt === 'string') ? {text: alt} : alt || {};
      alt.text = alt.text || null;
      alt.id = (alt.text) ? alt.id || 'qrcode-description' : null;

      // Compose title property surrogate
      title = (typeof title === 'string') ? {text: title} : title || {};
      title.text = title.text || null;
      title.id = (title.text) ? title.id || 'qrcode-title' : null;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var c, mc, r, mr, qrSvg='', rect;

      rect = 'l' + cellSize + ',0 0,' + cellSize +
        ' -' + cellSize + ',0 0,-' + cellSize + 'z ';

      qrSvg += '<svg version="1.1" xmlns="http://www.w3.org/2000/svg"';
      qrSvg += !opts.scalable ? ' width="' + size + 'px" height="' + size + 'px"' : '';
      qrSvg += ' viewBox="0 0 ' + size + ' ' + size + '" ';
      qrSvg += ' preserveAspectRatio="xMinYMin meet"';
      qrSvg += (title.text || alt.text) ? ' role="img" aria-labelledby="' +
          escapeXml([title.id, alt.id].join(' ').trim() ) + '"' : '';
      qrSvg += '>';
      qrSvg += (title.text) ? '<title id="' + escapeXml(title.id) + '">' +
          escapeXml(title.text) + '</title>' : '';
      qrSvg += (alt.text) ? '<description id="' + escapeXml(alt.id) + '">' +
          escapeXml(alt.text) + '</description>' : '';
      qrSvg += '<rect width="100%" height="100%" fill="white" cx="0" cy="0"/>';
      qrSvg += '<path d="';

      for (r = 0; r < _this.getModuleCount(); r += 1) {
        mr = r * cellSize + margin;
        for (c = 0; c < _this.getModuleCount(); c += 1) {
          if (_this.isDark(r, c) ) {
            mc = c*cellSize+margin;
            qrSvg += 'M' + mc + ',' + mr + rect;
          }
        }
      }

      qrSvg += '" stroke="transparent" fill="black"/>';
      qrSvg += '</svg>';

      return qrSvg;
    };

    _this.createDataURL = function(cellSize, margin) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      return createDataURL(size, size, function(x, y) {
        if (min <= x && x < max && min <= y && y < max) {
          var c = Math.floor( (x - min) / cellSize);
          var r = Math.floor( (y - min) / cellSize);
          return _this.isDark(r, c)? 0 : 1;
        } else {
          return 1;
        }
      } );
    };

    _this.createImgTag = function(cellSize, margin, alt) {

      cellSize = cellSize || 2;
      margin = (typeof margin == 'undefined')? cellSize * 4 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;

      var img = '';
      img += '<img';
      img += '\u0020src="';
      img += _this.createDataURL(cellSize, margin);
      img += '"';
      img += '\u0020width="';
      img += size;
      img += '"';
      img += '\u0020height="';
      img += size;
      img += '"';
      if (alt) {
        img += '\u0020alt="';
        img += escapeXml(alt);
        img += '"';
      }
      img += '/>';

      return img;
    };

    var escapeXml = function(s) {
      var escaped = '';
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charAt(i);
        switch(c) {
        case '<': escaped += '&lt;'; break;
        case '>': escaped += '&gt;'; break;
        case '&': escaped += '&amp;'; break;
        case '"': escaped += '&quot;'; break;
        default : escaped += c; break;
        }
      }
      return escaped;
    };

    var _createHalfASCII = function(margin) {
      var cellSize = 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r1, r2, p;

      var blocks = {
        '██': '█',
        '█ ': '▀',
        ' █': '▄',
        '  ': ' '
      };

      var blocksLastLineNoMargin = {
        '██': '▀',
        '█ ': '▀',
        ' █': ' ',
        '  ': ' '
      };

      var ascii = '';
      for (y = 0; y < size; y += 2) {
        r1 = Math.floor((y - min) / cellSize);
        r2 = Math.floor((y + 1 - min) / cellSize);
        for (x = 0; x < size; x += 1) {
          p = '█';

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r1, Math.floor((x - min) / cellSize))) {
            p = ' ';
          }

          if (min <= x && x < max && min <= y+1 && y+1 < max && _this.isDark(r2, Math.floor((x - min) / cellSize))) {
            p += ' ';
          }
          else {
            p += '█';
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          ascii += (margin < 1 && y+1 >= max) ? blocksLastLineNoMargin[p] : blocks[p];
        }

        ascii += '\n';
      }

      if (size % 2 && margin > 0) {
        return ascii.substring(0, ascii.length - size - 1) + Array(size+1).join('▀');
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.createASCII = function(cellSize, margin) {
      cellSize = cellSize || 1;

      if (cellSize < 2) {
        return _createHalfASCII(margin);
      }

      cellSize -= 1;
      margin = (typeof margin == 'undefined')? cellSize * 2 : margin;

      var size = _this.getModuleCount() * cellSize + margin * 2;
      var min = margin;
      var max = size - margin;

      var y, x, r, p;

      var white = Array(cellSize+1).join('██');
      var black = Array(cellSize+1).join('  ');

      var ascii = '';
      var line = '';
      for (y = 0; y < size; y += 1) {
        r = Math.floor( (y - min) / cellSize);
        line = '';
        for (x = 0; x < size; x += 1) {
          p = 1;

          if (min <= x && x < max && min <= y && y < max && _this.isDark(r, Math.floor((x - min) / cellSize))) {
            p = 0;
          }

          // Output 2 characters per pixel, to create full square. 1 character per pixels gives only half width of square.
          line += p ? white : black;
        }

        for (r = 0; r < cellSize; r += 1) {
          ascii += line + '\n';
        }
      }

      return ascii.substring(0, ascii.length-1);
    };

    _this.renderTo2dContext = function(context, cellSize) {
      cellSize = cellSize || 2;
      var length = _this.getModuleCount();
      for (var row = 0; row < length; row++) {
        for (var col = 0; col < length; col++) {
          context.fillStyle = _this.isDark(row, col) ? 'black' : 'white';
          context.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
        }
      }
    }

    return _this;
  };

  //---------------------------------------------------------------------
  // qrcode.stringToBytes
  //---------------------------------------------------------------------

  qrcode.stringToBytesFuncs = {
    'default' : function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        bytes.push(c & 0xff);
      }
      return bytes;
    }
  };

  qrcode.stringToBytes = qrcode.stringToBytesFuncs['default'];

  //---------------------------------------------------------------------
  // qrcode.createStringToBytes
  //---------------------------------------------------------------------

  /**
   * @param unicodeData base64 string of byte array.
   * [16bit Unicode],[16bit Bytes], ...
   * @param numChars
   */
  qrcode.createStringToBytes = function(unicodeData, numChars) {

    // create conversion map.

    var unicodeMap = function() {

      var bin = base64DecodeInputStream(unicodeData);
      var read = function() {
        var b = bin.read();
        if (b == -1) throw 'eof';
        return b;
      };

      var count = 0;
      var unicodeMap = {};
      while (true) {
        var b0 = bin.read();
        if (b0 == -1) break;
        var b1 = read();
        var b2 = read();
        var b3 = read();
        var k = String.fromCharCode( (b0 << 8) | b1);
        var v = (b2 << 8) | b3;
        unicodeMap[k] = v;
        count += 1;
      }
      if (count != numChars) {
        throw count + ' != ' + numChars;
      }

      return unicodeMap;
    }();

    var unknownChar = '?'.charCodeAt(0);

    return function(s) {
      var bytes = [];
      for (var i = 0; i < s.length; i += 1) {
        var c = s.charCodeAt(i);
        if (c < 128) {
          bytes.push(c);
        } else {
          var b = unicodeMap[s.charAt(i)];
          if (typeof b == 'number') {
            if ( (b & 0xff) == b) {
              // 1byte
              bytes.push(b);
            } else {
              // 2bytes
              bytes.push(b >>> 8);
              bytes.push(b & 0xff);
            }
          } else {
            bytes.push(unknownChar);
          }
        }
      }
      return bytes;
    };
  };

  //---------------------------------------------------------------------
  // QRMode
  //---------------------------------------------------------------------

  var QRMode = {
    MODE_NUMBER :    1 << 0,
    MODE_ALPHA_NUM : 1 << 1,
    MODE_8BIT_BYTE : 1 << 2,
    MODE_KANJI :     1 << 3
  };

  //---------------------------------------------------------------------
  // QRErrorCorrectionLevel
  //---------------------------------------------------------------------

  var QRErrorCorrectionLevel = {
    L : 1,
    M : 0,
    Q : 3,
    H : 2
  };

  //---------------------------------------------------------------------
  // QRMaskPattern
  //---------------------------------------------------------------------

  var QRMaskPattern = {
    PATTERN000 : 0,
    PATTERN001 : 1,
    PATTERN010 : 2,
    PATTERN011 : 3,
    PATTERN100 : 4,
    PATTERN101 : 5,
    PATTERN110 : 6,
    PATTERN111 : 7
  };

  //---------------------------------------------------------------------
  // QRUtil
  //---------------------------------------------------------------------

  var QRUtil = function() {

    var PATTERN_POSITION_TABLE = [
      [],
      [6, 18],
      [6, 22],
      [6, 26],
      [6, 30],
      [6, 34],
      [6, 22, 38],
      [6, 24, 42],
      [6, 26, 46],
      [6, 28, 50],
      [6, 30, 54],
      [6, 32, 58],
      [6, 34, 62],
      [6, 26, 46, 66],
      [6, 26, 48, 70],
      [6, 26, 50, 74],
      [6, 30, 54, 78],
      [6, 30, 56, 82],
      [6, 30, 58, 86],
      [6, 34, 62, 90],
      [6, 28, 50, 72, 94],
      [6, 26, 50, 74, 98],
      [6, 30, 54, 78, 102],
      [6, 28, 54, 80, 106],
      [6, 32, 58, 84, 110],
      [6, 30, 58, 86, 114],
      [6, 34, 62, 90, 118],
      [6, 26, 50, 74, 98, 122],
      [6, 30, 54, 78, 102, 126],
      [6, 26, 52, 78, 104, 130],
      [6, 30, 56, 82, 108, 134],
      [6, 34, 60, 86, 112, 138],
      [6, 30, 58, 86, 114, 142],
      [6, 34, 62, 90, 118, 146],
      [6, 30, 54, 78, 102, 126, 150],
      [6, 24, 50, 76, 102, 128, 154],
      [6, 28, 54, 80, 106, 132, 158],
      [6, 32, 58, 84, 110, 136, 162],
      [6, 26, 54, 82, 110, 138, 166],
      [6, 30, 58, 86, 114, 142, 170]
    ];
    var G15 = (1 << 10) | (1 << 8) | (1 << 5) | (1 << 4) | (1 << 2) | (1 << 1) | (1 << 0);
    var G18 = (1 << 12) | (1 << 11) | (1 << 10) | (1 << 9) | (1 << 8) | (1 << 5) | (1 << 2) | (1 << 0);
    var G15_MASK = (1 << 14) | (1 << 12) | (1 << 10) | (1 << 4) | (1 << 1);

    var _this = {};

    var getBCHDigit = function(data) {
      var digit = 0;
      while (data != 0) {
        digit += 1;
        data >>>= 1;
      }
      return digit;
    };

    _this.getBCHTypeInfo = function(data) {
      var d = data << 10;
      while (getBCHDigit(d) - getBCHDigit(G15) >= 0) {
        d ^= (G15 << (getBCHDigit(d) - getBCHDigit(G15) ) );
      }
      return ( (data << 10) | d) ^ G15_MASK;
    };

    _this.getBCHTypeNumber = function(data) {
      var d = data << 12;
      while (getBCHDigit(d) - getBCHDigit(G18) >= 0) {
        d ^= (G18 << (getBCHDigit(d) - getBCHDigit(G18) ) );
      }
      return (data << 12) | d;
    };

    _this.getPatternPosition = function(typeNumber) {
      return PATTERN_POSITION_TABLE[typeNumber - 1];
    };

    _this.getMaskFunction = function(maskPattern) {

      switch (maskPattern) {

      case QRMaskPattern.PATTERN000 :
        return function(i, j) { return (i + j) % 2 == 0; };
      case QRMaskPattern.PATTERN001 :
        return function(i, j) { return i % 2 == 0; };
      case QRMaskPattern.PATTERN010 :
        return function(i, j) { return j % 3 == 0; };
      case QRMaskPattern.PATTERN011 :
        return function(i, j) { return (i + j) % 3 == 0; };
      case QRMaskPattern.PATTERN100 :
        return function(i, j) { return (Math.floor(i / 2) + Math.floor(j / 3) ) % 2 == 0; };
      case QRMaskPattern.PATTERN101 :
        return function(i, j) { return (i * j) % 2 + (i * j) % 3 == 0; };
      case QRMaskPattern.PATTERN110 :
        return function(i, j) { return ( (i * j) % 2 + (i * j) % 3) % 2 == 0; };
      case QRMaskPattern.PATTERN111 :
        return function(i, j) { return ( (i * j) % 3 + (i + j) % 2) % 2 == 0; };

      default :
        throw 'bad maskPattern:' + maskPattern;
      }
    };

    _this.getErrorCorrectPolynomial = function(errorCorrectLength) {
      var a = qrPolynomial([1], 0);
      for (var i = 0; i < errorCorrectLength; i += 1) {
        a = a.multiply(qrPolynomial([1, QRMath.gexp(i)], 0) );
      }
      return a;
    };

    _this.getLengthInBits = function(mode, type) {

      if (1 <= type && type < 10) {

        // 1 - 9

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 10;
        case QRMode.MODE_ALPHA_NUM : return 9;
        case QRMode.MODE_8BIT_BYTE : return 8;
        case QRMode.MODE_KANJI     : return 8;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 27) {

        // 10 - 26

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 12;
        case QRMode.MODE_ALPHA_NUM : return 11;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 10;
        default :
          throw 'mode:' + mode;
        }

      } else if (type < 41) {

        // 27 - 40

        switch(mode) {
        case QRMode.MODE_NUMBER    : return 14;
        case QRMode.MODE_ALPHA_NUM : return 13;
        case QRMode.MODE_8BIT_BYTE : return 16;
        case QRMode.MODE_KANJI     : return 12;
        default :
          throw 'mode:' + mode;
        }

      } else {
        throw 'type:' + type;
      }
    };

    _this.getLostPoint = function(qrcode) {

      var moduleCount = qrcode.getModuleCount();

      var lostPoint = 0;

      // LEVEL1

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount; col += 1) {

          var sameCount = 0;
          var dark = qrcode.isDark(row, col);

          for (var r = -1; r <= 1; r += 1) {

            if (row + r < 0 || moduleCount <= row + r) {
              continue;
            }

            for (var c = -1; c <= 1; c += 1) {

              if (col + c < 0 || moduleCount <= col + c) {
                continue;
              }

              if (r == 0 && c == 0) {
                continue;
              }

              if (dark == qrcode.isDark(row + r, col + c) ) {
                sameCount += 1;
              }
            }
          }

          if (sameCount > 5) {
            lostPoint += (3 + sameCount - 5);
          }
        }
      };

      // LEVEL2

      for (var row = 0; row < moduleCount - 1; row += 1) {
        for (var col = 0; col < moduleCount - 1; col += 1) {
          var count = 0;
          if (qrcode.isDark(row, col) ) count += 1;
          if (qrcode.isDark(row + 1, col) ) count += 1;
          if (qrcode.isDark(row, col + 1) ) count += 1;
          if (qrcode.isDark(row + 1, col + 1) ) count += 1;
          if (count == 0 || count == 4) {
            lostPoint += 3;
          }
        }
      }

      // LEVEL3

      for (var row = 0; row < moduleCount; row += 1) {
        for (var col = 0; col < moduleCount - 6; col += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row, col + 1)
              &&  qrcode.isDark(row, col + 2)
              &&  qrcode.isDark(row, col + 3)
              &&  qrcode.isDark(row, col + 4)
              && !qrcode.isDark(row, col + 5)
              &&  qrcode.isDark(row, col + 6) ) {
            lostPoint += 40;
          }
        }
      }

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount - 6; row += 1) {
          if (qrcode.isDark(row, col)
              && !qrcode.isDark(row + 1, col)
              &&  qrcode.isDark(row + 2, col)
              &&  qrcode.isDark(row + 3, col)
              &&  qrcode.isDark(row + 4, col)
              && !qrcode.isDark(row + 5, col)
              &&  qrcode.isDark(row + 6, col) ) {
            lostPoint += 40;
          }
        }
      }

      // LEVEL4

      var darkCount = 0;

      for (var col = 0; col < moduleCount; col += 1) {
        for (var row = 0; row < moduleCount; row += 1) {
          if (qrcode.isDark(row, col) ) {
            darkCount += 1;
          }
        }
      }

      var ratio = Math.abs(100 * darkCount / moduleCount / moduleCount - 50) / 5;
      lostPoint += ratio * 10;

      return lostPoint;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // QRMath
  //---------------------------------------------------------------------

  var QRMath = function() {

    var EXP_TABLE = new Array(256);
    var LOG_TABLE = new Array(256);

    // initialize tables
    for (var i = 0; i < 8; i += 1) {
      EXP_TABLE[i] = 1 << i;
    }
    for (var i = 8; i < 256; i += 1) {
      EXP_TABLE[i] = EXP_TABLE[i - 4]
        ^ EXP_TABLE[i - 5]
        ^ EXP_TABLE[i - 6]
        ^ EXP_TABLE[i - 8];
    }
    for (var i = 0; i < 255; i += 1) {
      LOG_TABLE[EXP_TABLE[i] ] = i;
    }

    var _this = {};

    _this.glog = function(n) {

      if (n < 1) {
        throw 'glog(' + n + ')';
      }

      return LOG_TABLE[n];
    };

    _this.gexp = function(n) {

      while (n < 0) {
        n += 255;
      }

      while (n >= 256) {
        n -= 255;
      }

      return EXP_TABLE[n];
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrPolynomial
  //---------------------------------------------------------------------

  function qrPolynomial(num, shift) {

    if (typeof num.length == 'undefined') {
      throw num.length + '/' + shift;
    }

    var _num = function() {
      var offset = 0;
      while (offset < num.length && num[offset] == 0) {
        offset += 1;
      }
      var _num = new Array(num.length - offset + shift);
      for (var i = 0; i < num.length - offset; i += 1) {
        _num[i] = num[i + offset];
      }
      return _num;
    }();

    var _this = {};

    _this.getAt = function(index) {
      return _num[index];
    };

    _this.getLength = function() {
      return _num.length;
    };

    _this.multiply = function(e) {

      var num = new Array(_this.getLength() + e.getLength() - 1);

      for (var i = 0; i < _this.getLength(); i += 1) {
        for (var j = 0; j < e.getLength(); j += 1) {
          num[i + j] ^= QRMath.gexp(QRMath.glog(_this.getAt(i) ) + QRMath.glog(e.getAt(j) ) );
        }
      }

      return qrPolynomial(num, 0);
    };

    _this.mod = function(e) {

      if (_this.getLength() - e.getLength() < 0) {
        return _this;
      }

      var ratio = QRMath.glog(_this.getAt(0) ) - QRMath.glog(e.getAt(0) );

      var num = new Array(_this.getLength() );
      for (var i = 0; i < _this.getLength(); i += 1) {
        num[i] = _this.getAt(i);
      }

      for (var i = 0; i < e.getLength(); i += 1) {
        num[i] ^= QRMath.gexp(QRMath.glog(e.getAt(i) ) + ratio);
      }

      // recursive call
      return qrPolynomial(num, 0).mod(e);
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // QRRSBlock
  //---------------------------------------------------------------------

  var QRRSBlock = function() {

    var RS_BLOCK_TABLE = [

      // L
      // M
      // Q
      // H

      // 1
      [1, 26, 19],
      [1, 26, 16],
      [1, 26, 13],
      [1, 26, 9],

      // 2
      [1, 44, 34],
      [1, 44, 28],
      [1, 44, 22],
      [1, 44, 16],

      // 3
      [1, 70, 55],
      [1, 70, 44],
      [2, 35, 17],
      [2, 35, 13],

      // 4
      [1, 100, 80],
      [2, 50, 32],
      [2, 50, 24],
      [4, 25, 9],

      // 5
      [1, 134, 108],
      [2, 67, 43],
      [2, 33, 15, 2, 34, 16],
      [2, 33, 11, 2, 34, 12],

      // 6
      [2, 86, 68],
      [4, 43, 27],
      [4, 43, 19],
      [4, 43, 15],

      // 7
      [2, 98, 78],
      [4, 49, 31],
      [2, 32, 14, 4, 33, 15],
      [4, 39, 13, 1, 40, 14],

      // 8
      [2, 121, 97],
      [2, 60, 38, 2, 61, 39],
      [4, 40, 18, 2, 41, 19],
      [4, 40, 14, 2, 41, 15],

      // 9
      [2, 146, 116],
      [3, 58, 36, 2, 59, 37],
      [4, 36, 16, 4, 37, 17],
      [4, 36, 12, 4, 37, 13],

      // 10
      [2, 86, 68, 2, 87, 69],
      [4, 69, 43, 1, 70, 44],
      [6, 43, 19, 2, 44, 20],
      [6, 43, 15, 2, 44, 16],

      // 11
      [4, 101, 81],
      [1, 80, 50, 4, 81, 51],
      [4, 50, 22, 4, 51, 23],
      [3, 36, 12, 8, 37, 13],

      // 12
      [2, 116, 92, 2, 117, 93],
      [6, 58, 36, 2, 59, 37],
      [4, 46, 20, 6, 47, 21],
      [7, 42, 14, 4, 43, 15],

      // 13
      [4, 133, 107],
      [8, 59, 37, 1, 60, 38],
      [8, 44, 20, 4, 45, 21],
      [12, 33, 11, 4, 34, 12],

      // 14
      [3, 145, 115, 1, 146, 116],
      [4, 64, 40, 5, 65, 41],
      [11, 36, 16, 5, 37, 17],
      [11, 36, 12, 5, 37, 13],

      // 15
      [5, 109, 87, 1, 110, 88],
      [5, 65, 41, 5, 66, 42],
      [5, 54, 24, 7, 55, 25],
      [11, 36, 12, 7, 37, 13],

      // 16
      [5, 122, 98, 1, 123, 99],
      [7, 73, 45, 3, 74, 46],
      [15, 43, 19, 2, 44, 20],
      [3, 45, 15, 13, 46, 16],

      // 17
      [1, 135, 107, 5, 136, 108],
      [10, 74, 46, 1, 75, 47],
      [1, 50, 22, 15, 51, 23],
      [2, 42, 14, 17, 43, 15],

      // 18
      [5, 150, 120, 1, 151, 121],
      [9, 69, 43, 4, 70, 44],
      [17, 50, 22, 1, 51, 23],
      [2, 42, 14, 19, 43, 15],

      // 19
      [3, 141, 113, 4, 142, 114],
      [3, 70, 44, 11, 71, 45],
      [17, 47, 21, 4, 48, 22],
      [9, 39, 13, 16, 40, 14],

      // 20
      [3, 135, 107, 5, 136, 108],
      [3, 67, 41, 13, 68, 42],
      [15, 54, 24, 5, 55, 25],
      [15, 43, 15, 10, 44, 16],

      // 21
      [4, 144, 116, 4, 145, 117],
      [17, 68, 42],
      [17, 50, 22, 6, 51, 23],
      [19, 46, 16, 6, 47, 17],

      // 22
      [2, 139, 111, 7, 140, 112],
      [17, 74, 46],
      [7, 54, 24, 16, 55, 25],
      [34, 37, 13],

      // 23
      [4, 151, 121, 5, 152, 122],
      [4, 75, 47, 14, 76, 48],
      [11, 54, 24, 14, 55, 25],
      [16, 45, 15, 14, 46, 16],

      // 24
      [6, 147, 117, 4, 148, 118],
      [6, 73, 45, 14, 74, 46],
      [11, 54, 24, 16, 55, 25],
      [30, 46, 16, 2, 47, 17],

      // 25
      [8, 132, 106, 4, 133, 107],
      [8, 75, 47, 13, 76, 48],
      [7, 54, 24, 22, 55, 25],
      [22, 45, 15, 13, 46, 16],

      // 26
      [10, 142, 114, 2, 143, 115],
      [19, 74, 46, 4, 75, 47],
      [28, 50, 22, 6, 51, 23],
      [33, 46, 16, 4, 47, 17],

      // 27
      [8, 152, 122, 4, 153, 123],
      [22, 73, 45, 3, 74, 46],
      [8, 53, 23, 26, 54, 24],
      [12, 45, 15, 28, 46, 16],

      // 28
      [3, 147, 117, 10, 148, 118],
      [3, 73, 45, 23, 74, 46],
      [4, 54, 24, 31, 55, 25],
      [11, 45, 15, 31, 46, 16],

      // 29
      [7, 146, 116, 7, 147, 117],
      [21, 73, 45, 7, 74, 46],
      [1, 53, 23, 37, 54, 24],
      [19, 45, 15, 26, 46, 16],

      // 30
      [5, 145, 115, 10, 146, 116],
      [19, 75, 47, 10, 76, 48],
      [15, 54, 24, 25, 55, 25],
      [23, 45, 15, 25, 46, 16],

      // 31
      [13, 145, 115, 3, 146, 116],
      [2, 74, 46, 29, 75, 47],
      [42, 54, 24, 1, 55, 25],
      [23, 45, 15, 28, 46, 16],

      // 32
      [17, 145, 115],
      [10, 74, 46, 23, 75, 47],
      [10, 54, 24, 35, 55, 25],
      [19, 45, 15, 35, 46, 16],

      // 33
      [17, 145, 115, 1, 146, 116],
      [14, 74, 46, 21, 75, 47],
      [29, 54, 24, 19, 55, 25],
      [11, 45, 15, 46, 46, 16],

      // 34
      [13, 145, 115, 6, 146, 116],
      [14, 74, 46, 23, 75, 47],
      [44, 54, 24, 7, 55, 25],
      [59, 46, 16, 1, 47, 17],

      // 35
      [12, 151, 121, 7, 152, 122],
      [12, 75, 47, 26, 76, 48],
      [39, 54, 24, 14, 55, 25],
      [22, 45, 15, 41, 46, 16],

      // 36
      [6, 151, 121, 14, 152, 122],
      [6, 75, 47, 34, 76, 48],
      [46, 54, 24, 10, 55, 25],
      [2, 45, 15, 64, 46, 16],

      // 37
      [17, 152, 122, 4, 153, 123],
      [29, 74, 46, 14, 75, 47],
      [49, 54, 24, 10, 55, 25],
      [24, 45, 15, 46, 46, 16],

      // 38
      [4, 152, 122, 18, 153, 123],
      [13, 74, 46, 32, 75, 47],
      [48, 54, 24, 14, 55, 25],
      [42, 45, 15, 32, 46, 16],

      // 39
      [20, 147, 117, 4, 148, 118],
      [40, 75, 47, 7, 76, 48],
      [43, 54, 24, 22, 55, 25],
      [10, 45, 15, 67, 46, 16],

      // 40
      [19, 148, 118, 6, 149, 119],
      [18, 75, 47, 31, 76, 48],
      [34, 54, 24, 34, 55, 25],
      [20, 45, 15, 61, 46, 16]
    ];

    var qrRSBlock = function(totalCount, dataCount) {
      var _this = {};
      _this.totalCount = totalCount;
      _this.dataCount = dataCount;
      return _this;
    };

    var _this = {};

    var getRsBlockTable = function(typeNumber, errorCorrectionLevel) {

      switch(errorCorrectionLevel) {
      case QRErrorCorrectionLevel.L :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 0];
      case QRErrorCorrectionLevel.M :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 1];
      case QRErrorCorrectionLevel.Q :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 2];
      case QRErrorCorrectionLevel.H :
        return RS_BLOCK_TABLE[(typeNumber - 1) * 4 + 3];
      default :
        return undefined;
      }
    };

    _this.getRSBlocks = function(typeNumber, errorCorrectionLevel) {

      var rsBlock = getRsBlockTable(typeNumber, errorCorrectionLevel);

      if (typeof rsBlock == 'undefined') {
        throw 'bad rs block @ typeNumber:' + typeNumber +
            '/errorCorrectionLevel:' + errorCorrectionLevel;
      }

      var length = rsBlock.length / 3;

      var list = [];

      for (var i = 0; i < length; i += 1) {

        var count = rsBlock[i * 3 + 0];
        var totalCount = rsBlock[i * 3 + 1];
        var dataCount = rsBlock[i * 3 + 2];

        for (var j = 0; j < count; j += 1) {
          list.push(qrRSBlock(totalCount, dataCount) );
        }
      }

      return list;
    };

    return _this;
  }();

  //---------------------------------------------------------------------
  // qrBitBuffer
  //---------------------------------------------------------------------

  var qrBitBuffer = function() {

    var _buffer = [];
    var _length = 0;

    var _this = {};

    _this.getBuffer = function() {
      return _buffer;
    };

    _this.getAt = function(index) {
      var bufIndex = Math.floor(index / 8);
      return ( (_buffer[bufIndex] >>> (7 - index % 8) ) & 1) == 1;
    };

    _this.put = function(num, length) {
      for (var i = 0; i < length; i += 1) {
        _this.putBit( ( (num >>> (length - i - 1) ) & 1) == 1);
      }
    };

    _this.getLengthInBits = function() {
      return _length;
    };

    _this.putBit = function(bit) {

      var bufIndex = Math.floor(_length / 8);
      if (_buffer.length <= bufIndex) {
        _buffer.push(0);
      }

      if (bit) {
        _buffer[bufIndex] |= (0x80 >>> (_length % 8) );
      }

      _length += 1;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrNumber
  //---------------------------------------------------------------------

  var qrNumber = function(data) {

    var _mode = QRMode.MODE_NUMBER;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var data = _data;

      var i = 0;

      while (i + 2 < data.length) {
        buffer.put(strToNum(data.substring(i, i + 3) ), 10);
        i += 3;
      }

      if (i < data.length) {
        if (data.length - i == 1) {
          buffer.put(strToNum(data.substring(i, i + 1) ), 4);
        } else if (data.length - i == 2) {
          buffer.put(strToNum(data.substring(i, i + 2) ), 7);
        }
      }
    };

    var strToNum = function(s) {
      var num = 0;
      for (var i = 0; i < s.length; i += 1) {
        num = num * 10 + chatToNum(s.charAt(i) );
      }
      return num;
    };

    var chatToNum = function(c) {
      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      }
      throw 'illegal char :' + c;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrAlphaNum
  //---------------------------------------------------------------------

  var qrAlphaNum = function(data) {

    var _mode = QRMode.MODE_ALPHA_NUM;
    var _data = data;

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _data.length;
    };

    _this.write = function(buffer) {

      var s = _data;

      var i = 0;

      while (i + 1 < s.length) {
        buffer.put(
          getCode(s.charAt(i) ) * 45 +
          getCode(s.charAt(i + 1) ), 11);
        i += 2;
      }

      if (i < s.length) {
        buffer.put(getCode(s.charAt(i) ), 6);
      }
    };

    var getCode = function(c) {

      if ('0' <= c && c <= '9') {
        return c.charCodeAt(0) - '0'.charCodeAt(0);
      } else if ('A' <= c && c <= 'Z') {
        return c.charCodeAt(0) - 'A'.charCodeAt(0) + 10;
      } else {
        switch (c) {
        case ' ' : return 36;
        case '$' : return 37;
        case '%' : return 38;
        case '*' : return 39;
        case '+' : return 40;
        case '-' : return 41;
        case '.' : return 42;
        case '/' : return 43;
        case ':' : return 44;
        default :
          throw 'illegal char :' + c;
        }
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qr8BitByte
  //---------------------------------------------------------------------

  var qr8BitByte = function(data) {

    var _mode = QRMode.MODE_8BIT_BYTE;
    var _data = data;
    var _bytes = qrcode.stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return _bytes.length;
    };

    _this.write = function(buffer) {
      for (var i = 0; i < _bytes.length; i += 1) {
        buffer.put(_bytes[i], 8);
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // qrKanji
  //---------------------------------------------------------------------

  var qrKanji = function(data) {

    var _mode = QRMode.MODE_KANJI;
    var _data = data;

    var stringToBytes = qrcode.stringToBytesFuncs['SJIS'];
    if (!stringToBytes) {
      throw 'sjis not supported.';
    }
    !function(c, code) {
      // self test for sjis support.
      var test = stringToBytes(c);
      if (test.length != 2 || ( (test[0] << 8) | test[1]) != code) {
        throw 'sjis not supported.';
      }
    }('\u53cb', 0x9746);

    var _bytes = stringToBytes(data);

    var _this = {};

    _this.getMode = function() {
      return _mode;
    };

    _this.getLength = function(buffer) {
      return ~~(_bytes.length / 2);
    };

    _this.write = function(buffer) {

      var data = _bytes;

      var i = 0;

      while (i + 1 < data.length) {

        var c = ( (0xff & data[i]) << 8) | (0xff & data[i + 1]);

        if (0x8140 <= c && c <= 0x9FFC) {
          c -= 0x8140;
        } else if (0xE040 <= c && c <= 0xEBBF) {
          c -= 0xC140;
        } else {
          throw 'illegal char at ' + (i + 1) + '/' + c;
        }

        c = ( (c >>> 8) & 0xff) * 0xC0 + (c & 0xff);

        buffer.put(c, 13);

        i += 2;
      }

      if (i < data.length) {
        throw 'illegal char at ' + (i + 1);
      }
    };

    return _this;
  };

  //=====================================================================
  // GIF Support etc.
  //

  //---------------------------------------------------------------------
  // byteArrayOutputStream
  //---------------------------------------------------------------------

  var byteArrayOutputStream = function() {

    var _bytes = [];

    var _this = {};

    _this.writeByte = function(b) {
      _bytes.push(b & 0xff);
    };

    _this.writeShort = function(i) {
      _this.writeByte(i);
      _this.writeByte(i >>> 8);
    };

    _this.writeBytes = function(b, off, len) {
      off = off || 0;
      len = len || b.length;
      for (var i = 0; i < len; i += 1) {
        _this.writeByte(b[i + off]);
      }
    };

    _this.writeString = function(s) {
      for (var i = 0; i < s.length; i += 1) {
        _this.writeByte(s.charCodeAt(i) );
      }
    };

    _this.toByteArray = function() {
      return _bytes;
    };

    _this.toString = function() {
      var s = '';
      s += '[';
      for (var i = 0; i < _bytes.length; i += 1) {
        if (i > 0) {
          s += ',';
        }
        s += _bytes[i];
      }
      s += ']';
      return s;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64EncodeOutputStream
  //---------------------------------------------------------------------

  var base64EncodeOutputStream = function() {

    var _buffer = 0;
    var _buflen = 0;
    var _length = 0;
    var _base64 = '';

    var _this = {};

    var writeEncoded = function(b) {
      _base64 += String.fromCharCode(encode(b & 0x3f) );
    };

    var encode = function(n) {
      if (n < 0) {
        // error.
      } else if (n < 26) {
        return 0x41 + n;
      } else if (n < 52) {
        return 0x61 + (n - 26);
      } else if (n < 62) {
        return 0x30 + (n - 52);
      } else if (n == 62) {
        return 0x2b;
      } else if (n == 63) {
        return 0x2f;
      }
      throw 'n:' + n;
    };

    _this.writeByte = function(n) {

      _buffer = (_buffer << 8) | (n & 0xff);
      _buflen += 8;
      _length += 1;

      while (_buflen >= 6) {
        writeEncoded(_buffer >>> (_buflen - 6) );
        _buflen -= 6;
      }
    };

    _this.flush = function() {

      if (_buflen > 0) {
        writeEncoded(_buffer << (6 - _buflen) );
        _buffer = 0;
        _buflen = 0;
      }

      if (_length % 3 != 0) {
        // padding
        var padlen = 3 - _length % 3;
        for (var i = 0; i < padlen; i += 1) {
          _base64 += '=';
        }
      }
    };

    _this.toString = function() {
      return _base64;
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // base64DecodeInputStream
  //---------------------------------------------------------------------

  var base64DecodeInputStream = function(str) {

    var _str = str;
    var _pos = 0;
    var _buffer = 0;
    var _buflen = 0;

    var _this = {};

    _this.read = function() {

      while (_buflen < 8) {

        if (_pos >= _str.length) {
          if (_buflen == 0) {
            return -1;
          }
          throw 'unexpected end of file./' + _buflen;
        }

        var c = _str.charAt(_pos);
        _pos += 1;

        if (c == '=') {
          _buflen = 0;
          return -1;
        } else if (c.match(/^\s$/) ) {
          // ignore if whitespace.
          continue;
        }

        _buffer = (_buffer << 6) | decode(c.charCodeAt(0) );
        _buflen += 6;
      }

      var n = (_buffer >>> (_buflen - 8) ) & 0xff;
      _buflen -= 8;
      return n;
    };

    var decode = function(c) {
      if (0x41 <= c && c <= 0x5a) {
        return c - 0x41;
      } else if (0x61 <= c && c <= 0x7a) {
        return c - 0x61 + 26;
      } else if (0x30 <= c && c <= 0x39) {
        return c - 0x30 + 52;
      } else if (c == 0x2b) {
        return 62;
      } else if (c == 0x2f) {
        return 63;
      } else {
        throw 'c:' + c;
      }
    };

    return _this;
  };

  //---------------------------------------------------------------------
  // gifImage (B/W)
  //---------------------------------------------------------------------

  var gifImage = function(width, height) {

    var _width = width;
    var _height = height;
    var _data = new Array(width * height);

    var _this = {};

    _this.setPixel = function(x, y, pixel) {
      _data[y * _width + x] = pixel;
    };

    _this.write = function(out) {

      //---------------------------------
      // GIF Signature

      out.writeString('GIF87a');

      //---------------------------------
      // Screen Descriptor

      out.writeShort(_width);
      out.writeShort(_height);

      out.writeByte(0x80); // 2bit
      out.writeByte(0);
      out.writeByte(0);

      //---------------------------------
      // Global Color Map

      // black
      out.writeByte(0x00);
      out.writeByte(0x00);
      out.writeByte(0x00);

      // white
      out.writeByte(0xff);
      out.writeByte(0xff);
      out.writeByte(0xff);

      //---------------------------------
      // Image Descriptor

      out.writeString(',');
      out.writeShort(0);
      out.writeShort(0);
      out.writeShort(_width);
      out.writeShort(_height);
      out.writeByte(0);

      //---------------------------------
      // Local Color Map

      //---------------------------------
      // Raster Data

      var lzwMinCodeSize = 2;
      var raster = getLZWRaster(lzwMinCodeSize);

      out.writeByte(lzwMinCodeSize);

      var offset = 0;

      while (raster.length - offset > 255) {
        out.writeByte(255);
        out.writeBytes(raster, offset, 255);
        offset += 255;
      }

      out.writeByte(raster.length - offset);
      out.writeBytes(raster, offset, raster.length - offset);
      out.writeByte(0x00);

      //---------------------------------
      // GIF Terminator
      out.writeString(';');
    };

    var bitOutputStream = function(out) {

      var _out = out;
      var _bitLength = 0;
      var _bitBuffer = 0;

      var _this = {};

      _this.write = function(data, length) {

        if ( (data >>> length) != 0) {
          throw 'length over';
        }

        while (_bitLength + length >= 8) {
          _out.writeByte(0xff & ( (data << _bitLength) | _bitBuffer) );
          length -= (8 - _bitLength);
          data >>>= (8 - _bitLength);
          _bitBuffer = 0;
          _bitLength = 0;
        }

        _bitBuffer = (data << _bitLength) | _bitBuffer;
        _bitLength = _bitLength + length;
      };

      _this.flush = function() {
        if (_bitLength > 0) {
          _out.writeByte(_bitBuffer);
        }
      };

      return _this;
    };

    var getLZWRaster = function(lzwMinCodeSize) {

      var clearCode = 1 << lzwMinCodeSize;
      var endCode = (1 << lzwMinCodeSize) + 1;
      var bitLength = lzwMinCodeSize + 1;

      // Setup LZWTable
      var table = lzwTable();

      for (var i = 0; i < clearCode; i += 1) {
        table.add(String.fromCharCode(i) );
      }
      table.add(String.fromCharCode(clearCode) );
      table.add(String.fromCharCode(endCode) );

      var byteOut = byteArrayOutputStream();
      var bitOut = bitOutputStream(byteOut);

      // clear code
      bitOut.write(clearCode, bitLength);

      var dataIndex = 0;

      var s = String.fromCharCode(_data[dataIndex]);
      dataIndex += 1;

      while (dataIndex < _data.length) {

        var c = String.fromCharCode(_data[dataIndex]);
        dataIndex += 1;

        if (table.contains(s + c) ) {

          s = s + c;

        } else {

          bitOut.write(table.indexOf(s), bitLength);

          if (table.size() < 0xfff) {

            if (table.size() == (1 << bitLength) ) {
              bitLength += 1;
            }

            table.add(s + c);
          }

          s = c;
        }
      }

      bitOut.write(table.indexOf(s), bitLength);

      // end code
      bitOut.write(endCode, bitLength);

      bitOut.flush();

      return byteOut.toByteArray();
    };

    var lzwTable = function() {

      var _map = {};
      var _size = 0;

      var _this = {};

      _this.add = function(key) {
        if (_this.contains(key) ) {
          throw 'dup key:' + key;
        }
        _map[key] = _size;
        _size += 1;
      };

      _this.size = function() {
        return _size;
      };

      _this.indexOf = function(key) {
        return _map[key];
      };

      _this.contains = function(key) {
        return typeof _map[key] != 'undefined';
      };

      return _this;
    };

    return _this;
  };

  var createDataURL = function(width, height, getPixel) {
    var gif = gifImage(width, height);
    for (var y = 0; y < height; y += 1) {
      for (var x = 0; x < width; x += 1) {
        gif.setPixel(x, y, getPixel(x, y) );
      }
    }

    var b = byteArrayOutputStream();
    gif.write(b);

    var base64 = base64EncodeOutputStream();
    var bytes = b.toByteArray();
    for (var i = 0; i < bytes.length; i += 1) {
      base64.writeByte(bytes[i]);
    }
    base64.flush();

    return 'data:image/gif;base64,' + base64;
  };

  //---------------------------------------------------------------------
  // returns qrcode function.

  return qrcode;
}();

// multibyte support
!function() {

  qrcode.stringToBytesFuncs['UTF-8'] = function(s) {
    // http://stackoverflow.com/questions/18729405/how-to-convert-utf8-string-to-byte-array
    function toUTF8Array(str) {
      var utf8 = [];
      for (var i=0; i < str.length; i++) {
        var charcode = str.charCodeAt(i);
        if (charcode < 0x80) utf8.push(charcode);
        else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6),
              0x80 | (charcode & 0x3f));
        }
        else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(0xe0 | (charcode >> 12),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
        // surrogate pair
        else {
          i++;
          // UTF-16 encodes 0x10000-0x10FFFF by
          // subtracting 0x10000 and splitting the
          // 20 bits of 0x0-0xFFFFF into two halves
          charcode = 0x10000 + (((charcode & 0x3ff)<<10)
            | (str.charCodeAt(i) & 0x3ff));
          utf8.push(0xf0 | (charcode >>18),
              0x80 | ((charcode>>12) & 0x3f),
              0x80 | ((charcode>>6) & 0x3f),
              0x80 | (charcode & 0x3f));
        }
      }
      return utf8;
    }
    return toUTF8Array(s);
  };

}();


  return typeof qrcode === 'function' ? qrcode : undefined
}
/* ===== @dsh-mobile/host client ===== */
/**
 * DSH Mobile 的**浏览器半**：把 DSH 自带的文档预览能力交给手机外壳。
 *
 * ## 来路（2026-11-03 起就住在本包里）
 *
 * 它原来是独立包 `@dsh-mobile/bridge`（宿主半是空 `apply`），2026-10-31 并进
 * `@dsh-mobile/host`；2026-11-03 把那个独立包整个删掉，本文件成为**唯一源码** ✓
 * （`scripts/copy-client.mjs` 构建时复制成 `lib/client.js` ✓）。
 *
 * ★ 模块 id 必须等于**包名** ✓ —— DSH 的 `dsh-client-modules` 用 graph 行的名字
 *   （`@dsh-mobile/host`）来取这个模块 ✓。写成别的名字（并包初版就误写成
 *   `@dsh-mobile/bridge` ✗）会让 web boot 直接失败：
 *   `duplicate factory registration` + `@dsh-mobile/host: import failed` ✗ ——
 *   表现是"一启用插件 DSH 页面就进不去"✓。改这里之前先看 `copy-client.mjs` 的断言 ✓。
 *
 * ## 为什么需要它（查证过程见 05 §58）
 *
 * 用户记忆里"打开 md 就是渲染好的"那个预览，是 DSH 自带的
 * `@deepseek-ai/dsh-client-ui-sidebar-documentpreview` ✓ —— 它内置 KaTeX ✓，
 * 支持 Markdown / 代码 / 图片 / **PDF** / HTML ✓，而且**不需要任何部署** ✓。
 * 它的正式入口是 `ctx.sidebarRight.openResource(address)` ✓（DSH 自己的 README ✓），
 * 而 `ctx` 是 DSH 的依赖注入容器 ✓ —— 我们注入的 `boot.js` **拿不到它** ✗。
 * 所以必须由**宿主侧**声明一行（本包的 `dsh.client` + `cordis.patch.yml` 的 insert ✓），
 * 页面里的这份 `client.js` 才会被激活 ✓。
 *
 * ## 暴露什么
 *
 * `globalThis.__DSHM_DSH_PREVIEW__`：
 *   · `ready`     —— 服务齐了没有 ✓（拿不到就明确 false + reason ✓，不静默 ✗）
 *   · `open({ path, line })` —— 用 DSH 的预览打开一个**绝对路径** ✓
 *   · `state()`   —— 诊断：注入了哪些服务、有哪些会话可选 ✓
 *
 * 会话选择：DSH 的地址是**会话作用域**的 ✓（`dsh-resource://file/session/<id>/<path>` ✓，
 * 由 `fileAddressFor(sessionId, cwd, path)` 生成 ✓）。
 * 我们的文件面板是按**工作区路径**浏览的 ✗，所以这里挑一个
 * **cwd 是该路径祖先**的会话 ✓（没有就退回第一个会话 ✓，绝对路径照样能用 ✓）。
 */
window.__ModuleLoader__.load({
  id: '@dsh-mobile/host',
  factory: (require) => {
    // 左侧栏入口用 React（DSH 客户端模块表自带 react，与 ui-sidebar 用的是同一份 ✓）
    const React = require('react')
    /**
     * 地址构造：**优先用 DSH 自己的函数** ✓，拿不到就用下面这份**等价移植** ✓。
     *
     * 为什么会有移植：实测 `require('@deepseek-ai/dsh-util-workspace-path')` **拿不到** ✗ ——
     * 那个 util 在 chat 的 bundle 里是**内联**进去的 ✓（bundle 里能看到
     * `//#region ../../util/workspace-path/src/file-address.ts` ✓），
     * 并没有作为一个模块出现在 graph 里 ✗。
     * 移植来源：`@deepseek-ai/dsh-util-workspace-path/lib/index.js` 的
     * `sessionFileAddress` / `encodeSegment` / `encodePath` ✓（逐行对照过 ✓）。
     */
    let fileAddressForFromDsh
    try {
      fileAddressForFromDsh = require('@deepseek-ai/dsh-util-workspace-path').fileAddressFor
    } catch (error) {
      fileAddressForFromDsh = undefined
    }

    /** 地址前缀（与 DSH 的 `FILE_ADDRESS_PREFIX` 一致 ✓）。 */
    const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'
    /** 段编码：保留盘符里的 `:` 字面量 ✓（与 DSH 一致 ✓）。 */
    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ':')
    const encodePath = (path) => String(path).split('/').map(encodeSegment).join('/')

    /** 本包自带的地址构造（等价移植 ✓，用于 DSH 没暴露 util 的版本 ✓）。 */
    const fileAddressForLocal = (sessionId, cwd, path) => {
      const normalized = String(path).replace(/\\/g, '/')
      const root = cwd === undefined || cwd === '' ? '' : String(cwd).replace(/\\/g, '/').replace(/\/+$/, '')
      let relative = normalized.replace(/^(?:\.\/)+/, '')
      if (root !== '' && normalized === root) relative = ''
      else if (root !== '' && normalized.startsWith(root + '/')) relative = normalized.slice(root.length + 1)
      return `${FILE_ADDRESS_PREFIX}session/${encodeSegment(sessionId)}/${encodePath(relative)}`
    }

    /** 统一入口：能用 DSH 的就用 DSH 的 ✓（保证与 chat 的文件链接**逐字符一致** ✓）。 */
    const fileAddressFor = (sessionId, cwd, path) =>
      typeof fileAddressForFromDsh === 'function'
        ? fileAddressForFromDsh(sessionId, cwd, path)
        : fileAddressForLocal(sessionId, cwd, path)

    const inject = ['sessions', 'sidebarRight', 'conversation', 'inputTriggers']

    function apply(ctx) {
      const service = (name) => {
        try {
          return ctx.get !== undefined ? ctx.get(name) : ctx[name]
        } catch (error) {
          return undefined
        }
      }

      const state = () => {
        const sessions = service('sessions')
        const sidebarRight = service('sidebarRight')
        let ids = []
        try {
          ids = Object.keys(sessions?.list?.getSnapshot()?.byId ?? {})
        } catch (error) {
          ids = []
        }
        return {
          address: fileAddressForFromDsh === undefined ? 'ported（DSH 未暴露 util）' : 'dsh',
          hasSessions: sessions !== undefined,
          hasSidebarRight: sidebarRight !== undefined,
          sessions: ids.length,
        }
      }

      /** 挑一个能读这个路径的会话 ✓（优先 cwd 是它祖先的那个 ✓）。 */
      const pickSession = (target) => {
        const sessions = service('sessions')
        let entries = []
        try {
          entries = Object.entries(sessions?.list?.getSnapshot()?.byId ?? {})
        } catch (error) {
          entries = []
        }
        const wanted = String(target)
        const inside = entries.find(([, session]) => {
          const cwd = typeof session?.cwd === 'string' ? session.cwd.replace(/\/+$/, '') : ''
          return cwd !== '' && (wanted === cwd || wanted.startsWith(cwd + '/'))
        })
        return inside ?? entries[0]
      }

      /**
       * 用 DSH 的预览打开一个路径 ✓。
       * @returns `{ ok, reason?, address?, sessionId? }` —— 失败必须带原因 ✓（不静默 ✗）。
       */
      const open = (options) => {
        const target = typeof options === 'string' ? options : options?.path
        const line = typeof options === 'string' ? undefined : options?.line
        if (typeof target !== 'string' || target === '') return { ok: false, reason: '没有给出路径' }
        const sidebarRight = service('sidebarRight')
        if (sidebarRight === undefined || typeof sidebarRight.openResource !== 'function') {
          return { ok: false, reason: '这个 DSH 版本没有 sidebarRight.openResource' }
        }
        if (typeof fileAddressFor !== 'function') {
          return { ok: false, reason: '拿不到 fileAddressFor（DSH 内部包变了）' }
        }
        const picked = pickSession(target)
        if (picked === undefined) return { ok: false, reason: '当前没有任何会话（DSH 的预览需要会话作用域）' }
        const [sessionId, session] = picked
        const cwd = typeof session?.cwd === 'string' ? session.cwd : undefined
        const address = fileAddressFor(sessionId, cwd, target)
        try {
          if (line === undefined) sidebarRight.openResource(address)
          else sidebarRight.openResource(address, { params: { line } })
        } catch (error) {
          return { ok: false, reason: 'openResource 抛错：' + String(error && error.message ? error.message : error) }
        }
        return { ok: true, address, sessionId }
      }

      globalThis.__DSHM_DSH_PREVIEW__ = { ready: true, open, state }

      /**
       * ★ 2026-10-29（用户："自制一个新菜单，完全弃用 DSH 原生的菜单和命令键"）：
       *   给 boot.js 一个**往 composer 里放文本**的入口 ✓ —— DSH 的输入框是受控编辑器，
       *   `execCommand` 实测插不进去（text 为空 ✓）；这里走 DSH 自己的
       *   `conversation.input.setDraft`（dsh-purge 的 rewind 也是这么做的 ✓）。
       */
      const commandsBridge = {
        currentSessionId() {
          /**
           * ★★ 2026-10-29（用户："菜单点完了……没有东西出现"）：
           *   **DSH 里"当前会话"的真身是 `uiWorkspace.selection`** ✓（dsh-purge 的
           *   rewind 就是用它 ✓）；`sessions.list.current` 只是列表上的标记 ✗，
           *   实测它会指向**另一个/未 retained**的会话 ✗ ⇒ `shell()` 拿不到输入面 ⇒ 静默失败 ✗。
           *   ⇒ 先取 selection ✓，再退回 list.current ✓。
           */
          try {
            const workspace = service('uiWorkspace')
            const selected = workspace?.selection?.getSnapshot?.()?.sessionId
            if (typeof selected === 'string' && selected !== '') return selected
          } catch (error) {
            /* ignore */
          }
          try {
            const sessions = service('sessions')
            const snap = sessions?.list?.getSnapshot?.()
            if (snap?.current) return String(snap.current)
            if (Array.isArray(snap?.ids) && snap.ids.length > 0) return String(snap.ids[0])
            const ids = Object.keys(snap?.byId ?? {})
            if (ids.length > 0) return String(ids[0])
          } catch (error) {
            /* ignore */
          }
          try {
            const fromUrl = new URLSearchParams(location.search).get('session')
            if (fromUrl !== null && fromUrl !== '') return fromUrl
          } catch (error) {
            /* ignore */
          }
          return ''
        },
        insert(sessionId, text) {
          if (typeof text !== 'string' || text === '') return false
          const conversation = service('conversation')
          const input = conversation?.input
          if (input === undefined || input === null) return false
          const ids = []
          const pushId = (value) => {
            if (typeof value !== 'string' || value === '') return
            if (ids.includes(value)) return
            ids.push(value)
          }
          pushId(sessionId)
          pushId(commandsBridge.currentSessionId())
          try {
            const fromUrl = new URLSearchParams(location.search).get('session')
            pushId(fromUrl)
          } catch (error) {
            /* ignore */
          }
          const sessions = service('sessions')
          const faces = []
          for (const id of ids) {
            try {
              if (typeof input.shell === 'function') faces.push(input.shell(id))
            } catch (error) {
              /* ignore */
            }
            try {
              const scope = typeof sessions?.scope === 'function' ? sessions.scope(id) : undefined
              if (typeof input.for === 'function' && scope !== undefined) faces.push(input.for(scope))
            } catch (error) {
              /* ignore */
            }
          }
          faces.push(input)
          /**
           * ★ 2026-10-29（用户："输入命令不要清输入框内容，直接在当前输入框接着"）：
           *   `setDraft` 是**整体替换** ✗ ⇒ 先读当前 draft ✓（dsh-purge 的 liveDraft 同款：
           *   面自身的 `state.getSnapshot().draft` ✓），再拼接 ✓；拿不到状态时退回读 DOM 输入框 ✓。
           */
          /**
           * ★ 2026-10-29（实测：追加变成了替换）：面自身的 `state.draft` **不一定**跟着
           *   `setDraft` 更新 ✗（实测第一次写 `/goal ` 后它仍是空串 ⇒ 第二次又算成空 ⇒ 覆盖 ✗）。
           *   **可见输入框的 DOM 才是真话** ✓ ⇒ 先读 DOM ✓；读不到再用面状态 ✓。
           */
          const readDraft = (face) => {
            try {
              const node = document.querySelector('[data-composer-card="true"] [contenteditable="true"], [data-composer-card="true"] textarea')
              if (node !== null) {
                const text = node.tagName === 'TEXTAREA' ? String(node.value || '') : String(node.innerText || '')
                if (text !== '') return text.replace(/\u200b/g, '')
              }
            } catch (error) {
              /* ignore */
            }
            try {
              const snapshot = face === undefined || face === null ? undefined : face.state?.getSnapshot?.()
              if (snapshot !== undefined && snapshot !== null && typeof snapshot.draft === 'string') return snapshot.draft
            } catch (error) {
              /* ignore */
            }
            return ''
          }
          for (const face of faces) {
            if (face === undefined || face === null) continue
            if (typeof face.setDraft !== 'function') continue
            try {
              const current = readDraft(face)
              const separator = current === '' || /\s$/.test(current) ? '' : ' '
              face.setDraft(current + separator + text)
              return true
            } catch (error) {
              /* try next */
            }
          }
          return false
        },
      }
      globalThis.__DSHM_DSH_COMMANDS__ = commandsBridge

      /**
       * ★ 2026-10-29（用户："聊天框打 / 还会出现原生的菜单，这个主要是表现不好，直接去掉吧"）：
       *   把 `@deepseek-ai/dsh-client-ui-input-trigger` 里 **command 源**的 `candidates`
       *   换成空数组 ✓ —— 斜杠候选菜单永远没有行 ✓（不是先画出来再藏 ✗，所以不会闪 ✓）。
       *   手打 `/cmd` 文本本身照常可输入、可发送 ✓（命令执行走发送链，不依赖这张菜单 ✓）。
       *   源是 ui-commands 插件在启动时注册的 ✓ ⇒ 这里做一次有界轮询（最多 ~30s）等它出现 ✓。
       */
      const neutralizeSlashCommandMenu = () => {
        try {
          const inputTriggers = service('inputTriggers')
          const live = inputTriggers === undefined || inputTriggers === null ? undefined : inputTriggers.live
          const sources = live === undefined || live === null ? undefined : live.sources
          if (!Array.isArray(sources)) return false
          let patched = false
          for (const source of sources) {
            if (source === undefined || source === null) continue
            if (source.trigger !== '/' || source.name !== 'command') continue
            source.candidates = () => Promise.resolve([])
            patched = true
          }
          if (patched === true) {
            try {
              const controllers = live.controllers
              if (controllers !== undefined && controllers !== null && typeof controllers.values === 'function') {
                for (const controller of controllers.values()) {
                  try {
                    if (typeof controller.dismiss === 'function') controller.dismiss()
                  } catch (error) {
                    /* 单个会话失败不影响其它 */
                  }
                }
              }
            } catch (error) {
              /* ignore */
            }
          }
          return patched
        } catch (error) {
          return false
        }
      }
      let slashMenuTries = 0
      const slashMenuTimer = setInterval(() => {
        slashMenuTries += 1
        if (neutralizeSlashCommandMenu() === true || slashMenuTries >= 100) clearInterval(slashMenuTimer)
      }, 300)

      /**
       * ★★ 2026-11-03（用户："把配对页放进左侧栏入口吧"，后又："重做一个直接适配 dsh 的左边栏打开"）：
       *   电脑端配对控制台的**原生面板** ✓ —— 不是 iframe 那张独立页 ✗。
       *
       * `sidebar.panellist` 一行 + `main` 键控面板（同一个 id）✓，这是 DSH 自己的"全局面板"契约 ✓；
       * 面板直接调**同源**的 `/mobile/pair/*`（插件注册在 DSH webServer 的 `/mobile` 前缀上 ✓，
       * 请求走 loopback ⇒ `isLoopbackRequest` 放行 ✓），二维码在**客户端**用随包的
       * `qrcode-generator` 画成 SVG ✓（`copy-client.mjs` 把它内联进 lib/client.js ✓）——
       * 不猜端口 ✗、不依赖宿主新路由 ✗、不受窗口 CSP/iframe 限制 ✓。
       *
       * 只在电脑端注册 ✓：手机壳 / 我们的页面路径以 `/mobile/` 开头 ⇒ 那里的 `127.0.0.1` 是手机自己 ✗。
       * `slots` 不写进 `inject`（少一个服务不能把文档预览一起拖垮 ✗）⇒ 拿不到时最多轮询 10 秒 ✓。
       */
      const registerPairingPanel = () => {
        try {
          if (typeof document === 'undefined' || typeof location === 'undefined') return true
          const path = String(location.pathname || '')
          if (path.startsWith('/mobile/')) return true
          const slots = service('slots')
          if (slots === undefined || slots === null) return false
          if (typeof slots.inject !== 'function' || typeof slots.register !== 'function') return true

          const PANEL_ID = 'dsh-mobile-pairing'
          const h = React.createElement
          const T = {
            border: 'var(--dsw-alias-border-l2, rgba(127,127,127,.26))',
            borderStrong: 'var(--dsw-alias-border-l3, rgba(127,127,127,.42))',
            surface: 'var(--dsw-alias-bg-l2, rgba(127,127,127,.055))',
            surfaceRaised: 'var(--dsw-alias-bg-l1, rgba(127,127,127,.08))',
            hover: 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))',
            primary: 'var(--dsw-alias-state-business-primary, #4d6bfe)',
            onPrimary: '#ffffff',
            muted: 'var(--dsw-alias-label-secondary, rgba(127,127,127,.9))',
            error: 'var(--dsw-alias-state-error-primary, #e5484d)',
            success: 'var(--dsw-alias-state-success-primary, #46a758)',
          }
          const mono = { fontFamily: 'var(--ds-font-family-code, ui-monospace, SFMono-Regular, Menlo, monospace)' }
          const muted = { color: T.muted }
          const card = {
            border: '1px solid ' + T.border,
            borderRadius: 12,
            padding: 18,
            background: T.surface,
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
          }
          const codeBox = {
            width: 34,
            height: 44,
            borderRadius: 8,
            border: '1px solid ' + T.borderStrong,
            background: T.surfaceRaised,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: mono.fontFamily,
            fontSize: 21,
            fontWeight: 600,
          }
          const btn = (primary) => ({
            cursor: 'pointer',
            border: primary ? 0 : '1px solid ' + T.borderStrong,
            borderRadius: 8,
            padding: primary ? '8px 16px' : '7px 14px',
            background: primary ? T.primary : 'transparent',
            color: primary ? T.onPrimary : 'inherit',
            font: 'inherit',
            fontSize: 13,
            fontWeight: primary ? 600 : 400,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          })
          const Button = (props) =>
            h('button', {
              type: 'button',
              onClick: props.onClick,
              disabled: props.disabled === true,
              style: Object.assign(btn(props.primary === true), props.disabled === true ? { opacity: 0.5, cursor: 'default' } : null),
            }, props.children)
          const Section = (props) =>
            h(
              'section',
              { style: card },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10 } },
                h(
                  'span',
                  {
                    style: {
                      width: 20, height: 20, borderRadius: '50%', flex: 'none',
                      background: T.primary, color: T.onPrimary, fontSize: 11, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    },
                  },
                  String(props.step),
                ),
                h('h3', { style: { margin: 0, fontSize: 14, fontWeight: 600 } }, props.title),
                h('span', { style: { flex: 1 } }),
                props.extra === undefined ? null : props.extra,
              ),
              props.children,
            )
          const call = async (apiPath, init) => {
            const response = await fetch(apiPath, Object.assign({ credentials: 'same-origin' }, init))
            if (!response.ok) {
              let message = 'HTTP ' + response.status
              try {
                const body = await response.json()
                if (body !== null && typeof body === 'object' && typeof body.message === 'string') message = body.message
              } catch (error) { void error }
              throw new Error(message)
            }
            return response.json()
          }
          const formatFingerprint = (value) => {
            const text = String(value || '').replace(/[^0-9a-fA-F]/g, '').toUpperCase()
            let out = ''
            for (let i = 0; i < text.length; i += 4) out += (out.length > 0 ? ' ' : '') + text.slice(i, i + 4)
            return out
          }
          /**
           * 客户端画二维码 ✓ —— `globalThis.__DSHM_QR__` 由 `copy-client.mjs` 内联的
           * `qrcode-generator-2.0.4.js` 在 bundle 顶层设置 ✓。返回 `{ count, path }`，
           * path 是 SVG 的紧凑写法（一个 `<path>` 画完全部黑块 ✓）。
           */
          let qrFactoryCache
          const qrFactory = () => {
            if (qrFactoryCache !== undefined) return qrFactoryCache
            try {
              qrFactoryCache =
                typeof globalThis.__DSHM_QR_FACTORY__ === 'function' ? globalThis.__DSHM_QR_FACTORY__() : undefined
            } catch (error) {
              qrFactoryCache = undefined
            }
            return qrFactoryCache
          }
          const qrMatrix = (payload) => {
            const factory = qrFactory()
            if (typeof factory !== 'function') return null
            try {
              const qr = factory(0, 'M')
              qr.addData(String(payload))
              qr.make()
              const count = qr.getModuleCount()
              let d = ''
              for (let r = 0; r < count; r += 1) {
                for (let c = 0; c < count; c += 1) {
                  if (qr.isDark(r, c)) d += 'M' + c + ' ' + r + 'h1v1h-1z'
                }
              }
              return { count, path: d }
            } catch (error) {
              return null
            }
          }
          const PairingIcon = () =>
            h(
              'svg',
              { width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false' },
              h('rect', { x: 6, y: 2.5, width: 12, height: 19, rx: 2.6 }),
              h('path', { d: 'M9.6 5.6h4.8' }),
              h('circle', { cx: 12, cy: 17.6, r: 1.1, fill: 'currentColor', stroke: 'none' }),
            )

          const PairingPanel = () => {
            const [manifest, setManifest] = React.useState(null)
            const [pairing, setPairing] = React.useState(null)
            const [pending, setPending] = React.useState([])
            const [error, setError] = React.useState('')
            const [note, setNote] = React.useState('')
            const [busy, setBusy] = React.useState(false)
            const [copied, setCopied] = React.useState('')
            const [now, setNow] = React.useState(Date.now())

            React.useEffect(() => {
              let alive = true
              const pullPending = async () => {
                try {
                  const data = await call('/mobile/pair/pending')
                  if (alive) {
                    setPending(Array.isArray(data.pairings) ? data.pairings : [])
                    setNow(Date.now())
                  }
                } catch (failure) {
                  if (alive) setError(String(failure && failure.message ? failure.message : failure))
                }
              }
              void (async () => {
                try {
                  const data = await call('/mobile/manifest')
                  if (alive) setManifest(data)
                } catch (failure) {
                  if (alive) setError(String(failure && failure.message ? failure.message : failure))
                }
                await pullPending()
              })()
              const timer = setInterval(pullPending, 1500)
              return () => {
                alive = false
                clearInterval(timer)
              }
            }, [])

            const generate = async () => {
              setBusy(true); setError(''); setNote(''); setCopied('')
              try {
                const created = await call('/mobile/pair/code', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: '{}',
                })
                setPairing(created)
              } catch (failure) {
                setError(String(failure && failure.message ? failure.message : failure))
              } finally {
                setBusy(false)
              }
            }
            const decide = async (row, approve) => {
              setBusy(true); setError(''); setNote('')
              try {
                await call('/mobile/pair/confirm', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ code: row.code, deviceId: row.deviceId, approve: approve === true }),
                })
                setNote(approve === true ? '已允许该设备，手机随后会自动连上。' : '已拒绝该设备。')
              } catch (failure) {
                setError(String(failure && failure.message ? failure.message : failure))
              } finally {
                setBusy(false)
              }
            }
            const copyText = async (kind, text) => {
              if (typeof text !== 'string' || text.length === 0) return
              try {
                await navigator.clipboard.writeText(text)
                setCopied(kind)
                setError('')
              } catch (failure) {
                setError('复制失败：请手动选中文本复制')
              }
            }

            const ticket = pairing !== null && pairing.ticket !== undefined ? pairing.ticket : null
            const expiresAt = pairing !== null && typeof pairing.expiresAt === 'string' ? Date.parse(pairing.expiresAt) : Number.NaN
            const expired = Number.isFinite(expiresAt) && expiresAt <= now
            const qr = React.useMemo(() => (pairing !== null && typeof pairing.qrPayload === 'string' ? qrMatrix(pairing.qrPayload) : null), [pairing])
            const waitRows = pending.filter(
              (row) =>
                row !== null &&
                (row.state === 'open' || row.state === 'claimed') &&
                (typeof row.deviceId === 'string' || typeof row.fingerprint === 'string'),
            )
            const phoneBase =
              manifest !== null && typeof manifest.phoneBaseUrl === 'string' ? manifest.phoneBaseUrl.replace(/\/+$/, '') : ''
            const phoneUrl = phoneBase.length > 0 ? phoneBase + '/mobile' : ''
            const ca =
              manifest !== null && manifest.tls !== undefined && manifest.tls !== null && typeof manifest.tls.caFingerprint === 'string'
                ? manifest.tls.caFingerprint
                : ''

            const digits = ticket !== null ? String(ticket.code).split('') : []
            return h(
              'div',
              { style: { height: '100%', minHeight: 0, overflow: 'auto', padding: '26px 32px 36px', boxSizing: 'border-box' } },
              h(
                'div',
                { style: { maxWidth: 880, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 16 } },
                // ── 标题 ─────────────────────────────────────────────
                h(
                  'div',
                  { style: { display: 'flex', alignItems: 'flex-start', gap: 12 } },
                  h(
                    'span',
                    {
                      style: {
                        width: 38, height: 38, borderRadius: 11, flex: 'none',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        background: 'rgba(77,107,254,.14)', color: T.primary,
                      },
                    },
                    h(PairingIcon),
                  ),
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h('h2', { style: { margin: 0, fontSize: 18, fontWeight: 600 } }, '手机配对'),
                    h(
                      'p',
                      { style: Object.assign({ margin: '4px 0 0', fontSize: 12.5, lineHeight: 1.6 }, muted) },
                      '配对控制台 · 本机回环（127.0.0.1）。手机 App 扫码，或手机浏览器打开下面的 HTTPS 地址。',
                    ),
                    phoneUrl.length > 0
                      ? h(
                          'div',
                          { style: { display: 'flex', alignItems: 'center', gap: 8, marginTop: 8, flexWrap: 'wrap' } },
                          h(
                            'code',
                            {
                              style: Object.assign({}, mono, {
                                fontSize: 12, padding: '3px 8px', borderRadius: 6,
                                border: '1px solid ' + T.border, background: T.surfaceRaised,
                                wordBreak: 'break-all',
                              }),
                            },
                            phoneUrl,
                          ),
                          h(Button, { onClick: () => copyText('phone', phoneUrl) }, copied === 'phone' ? '已复制' : '复制'),
                        )
                      : h('p', { style: Object.assign({ margin: '6px 0 0', fontSize: 12 }, muted) }, '宿主未配置 phoneBaseUrl（手机浏览器地址不可用）'),
                  ),
                ),
                // ── 提示 ─────────────────────────────────────────────
                error.length > 0
                  ? h('div', { style: { padding: '9px 12px', borderRadius: 8, fontSize: 12.5, color: T.error, background: 'rgba(229,72,77,.10)', border: '1px solid rgba(229,72,77,.25)' } }, error)
                  : null,
                note.length > 0
                  ? h('div', { style: { padding: '9px 12px', borderRadius: 8, fontSize: 12.5, color: T.success, background: 'rgba(70,167,88,.10)', border: '1px solid rgba(70,167,88,.25)' } }, note)
                  : null,
                // ── 生成配对码 ──────────────────────────────────────
                h(
                  Section,
                  {
                    step: 1,
                    title: '生成配对码',
                    extra: ticket !== null
                      ? h(Button, { onClick: generate, disabled: busy }, pairing === null ? '生成' : '重新生成')
                      : null,
                  },
                  ticket === null
                    ? h(
                        'div',
                        { style: { display: 'flex', alignItems: 'center', flexDirection: 'column', gap: 12, padding: '18px 0 22px' } },
                        h(Button, { primary: true, onClick: generate, disabled: busy }, busy ? '生成中…' : '生成配对码'),
                        h('p', { style: Object.assign({ margin: 0, fontSize: 12 }, muted) }, '点一次生成 6 位配对码和二维码；有效期 5 分钟。'),
                      )
                    : h(
                        'div',
                        { style: { display: 'flex', gap: 22, alignItems: 'flex-start', flexWrap: 'wrap' } },
                        // 二维码
                        h(
                          'div',
                          {
                            style: {
                              flex: 'none', width: 268, borderRadius: 12, padding: 12,
                              background: '#ffffff', boxShadow: '0 1px 3px rgba(0,0,0,.10)',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
                            },
                          },
                          expired
                            ? h('div', { style: Object.assign({ width: 244, height: 244, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#666', textAlign: 'center' }, mono) }, '配对码已过期，点右上角重新生成')
                            : qr === null
                              ? h('div', { style: Object.assign({ width: 244, height: 244, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, color: '#666', textAlign: 'center' }, mono) }, '二维码组件未加载：刷新页面')
                              : h(
                                  'svg',
                                  {
                                    viewBox: '0 0 ' + qr.count + ' ' + qr.count,
                                    width: 244, height: 244,
                                    shapeRendering: 'crispEdges',
                                    role: 'img',
                                    'aria-label': '配对二维码',
                                  },
                                  h('rect', { width: qr.count, height: qr.count, fill: '#ffffff' }),
                                  h('path', { d: qr.path, fill: '#000000' }),
                                ),
                          h('div', { style: { fontSize: 11.5, color: '#6b7280' } }, expired ? '已过期' : '用手机 App 扫码'),
                        ),
                        // 右侧信息
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 260, display: 'flex', flexDirection: 'column', gap: 12 } },
                          h(
                            'div',
                            { style: { display: 'flex', gap: 6, alignItems: 'center' } },
                            digits.map((digit, index) => h('span', { key: index, style: codeBox }, digit)),
                          ),
                          h(
                            'div',
                            { style: Object.assign({ fontSize: 12 }, muted) },
                            expired
                              ? '配对码已过期'
                              : '有效期至 ' + new Date(expiresAt).toLocaleTimeString(),
                          ),
                          h(
                            'p',
                            { style: { margin: 0, fontSize: 12.5, lineHeight: 1.7, color: T.muted } },
                            '手机装了 App 直接扫左侧二维码；没装 App 就用手机浏览器打开上面的 HTTPS 地址，把配对链接粘进去。',
                          ),
                          h(
                            'div',
                            { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                            h(
                              Button,
                              { primary: true, onClick: () => copyText('link', pairing !== null ? pairing.qrPayload : '') },
                              copied === 'link' ? '已复制配对链接' : '复制配对链接',
                            ),
                            h(
                              'details',
                              { style: { alignSelf: 'center' } },
                              h('summary', { style: Object.assign({ cursor: 'pointer', fontSize: 12 }, muted) }, '查看链接'),
                              h(
                                'code',
                                {
                                  style: Object.assign({}, mono, {
                                    display: 'block', marginTop: 6, maxWidth: 360, maxHeight: 88, overflow: 'auto',
                                    fontSize: 10, lineHeight: 1.5, opacity: 0.8, wordBreak: 'break-all',
                                  }),
                                },
                                String(pairing !== null ? pairing.qrPayload : ''),
                              ),
                            ),
                          ),
                        ),
                      ),
                ),
                // ── 允许设备 ────────────────────────────────────────
                h(
                  Section,
                  { step: 2, title: '允许设备' },
                  waitRows.length === 0
                    ? h(
                        'div',
                        {
                          style: {
                            padding: '18px 14px', borderRadius: 10, textAlign: 'center',
                            border: '1px dashed ' + T.border, color: T.muted, fontSize: 12.5,
                          },
                        },
                        '手机扫码后，这里会出现设备名称与指纹，点「允许此设备」完成配对。',
                      )
                    : waitRows.map((row) =>
                        h(
                          'div',
                          {
                            key: String(row.code),
                            style: {
                              border: '1px solid ' + T.border, borderRadius: 10, padding: 14,
                              display: 'flex', flexDirection: 'column', gap: 8, background: T.surfaceRaised,
                            },
                          },
                          h(
                            'div',
                            { style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } },
                            h('span', { style: { fontSize: 13.5, fontWeight: 600 } }, String(row.name || row.deviceId || '未知设备')),
                            row.model !== undefined || row.platform !== undefined
                              ? h('span', { style: Object.assign({ fontSize: 11.5 }, muted) }, [row.model, row.platform].filter(Boolean).join(' · '))
                              : null,
                          ),
                          typeof row.fingerprint === 'string'
                            ? h(
                                'div',
                                { style: Object.assign({}, mono, { fontSize: 11, opacity: 0.78, wordBreak: 'break-all', letterSpacing: '.04em' }) },
                                '指纹 ' + formatFingerprint(row.fingerprint),
                              )
                            : h('div', { style: Object.assign({ fontSize: 11.5 }, muted) }, '等待手机提交指纹…'),
                          typeof row.deviceId === 'string' && typeof row.fingerprint === 'string'
                            ? h(
                                'div',
                                { style: { display: 'flex', gap: 8, marginTop: 2 } },
                                h(Button, { primary: true, onClick: () => decide(row, true), disabled: busy }, '允许此设备'),
                                h(Button, { onClick: () => decide(row, false), disabled: busy }, '拒绝'),
                              )
                            : null,
                        ),
                      ),
                ),
                // ── CA 指纹（折叠）──────────────────────────────────
                ca.length > 0
                  ? h(
                      'details',
                      { style: { fontSize: 11.5 } },
                      h('summary', { style: Object.assign({ cursor: 'pointer' }, muted) }, '本机 CA 指纹（首次连接时手机壳会显示同一串）'),
                      h(
                        'code',
                        { style: Object.assign({}, mono, { display: 'block', marginTop: 6, fontSize: 10.5, wordBreak: 'break-all', opacity: 0.75 }) },
                        ca,
                      ),
                    )
                  : null,
              ),
            )
          }

          slots.inject('sidebar.panellist', () =>
            slots.register({ name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: '手机配对' }, PairingIcon),
          )
          slots.inject('main', () => slots.register({ name: 'main', key: PANEL_ID }, PairingPanel))

          /**
           * ★★★ 2026-11-08（用户：「你把这个多余的画去掉就行吧」）—— **这里原来有一段
           *   `TopbarActions`，往 `conversation.session.header.actions` 里塞一个文案为
           *   `dsh-purge` 的兜底按钮**，本轮整段删掉 ✓，别再加回来 ✗：
           *   · 它是 2026-11-04 为「purge 顶栏入口被 DSH 新版条件显示掉」加的；那台机器上
           *     purge 本体的三个入口早已被**破甲**（`@local/dsh-purge-entry`，本地插件）收进左侧栏 ✓；
           *   · 更糟的是判据只看了「purge 有没有内联页签」——破甲隐藏用的是 CSS `display:none`
           *     （隐藏 ≠ 移除 ⇒ `querySelector` 照样命中），所以在**装了破甲的机器上**它被顺带遮住，
           *     而在**别人没装 purge 的新电脑上**它恒为显示 ⇒ 一个点不动的死按钮 ✓（用户就是这么发现的）✓；
           *   · 结论：purge 的入口归 purge/破甲自己管 ✓，我们不再冒充它的入口 ✓。
           *   守卫：`packages/host/test/purge-shortcut-gate.test.ts` 反向断言「这里不许再出现」✓。
           */
          return true
        } catch (error) {
          return true
        }
      }
      if (!registerPairingPanel()) {
        let pairingTries = 0
        const pairingTimer = setInterval(() => {
          pairingTries += 1
          if (registerPairingPanel() || pairingTries >= 50) clearInterval(pairingTimer)
        }, 200)
      }
    }

    return { apply, inject }
  },
})
