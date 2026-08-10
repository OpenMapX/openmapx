Pod::Spec.new do |s|
  s.name           = 'OpenMapXNavigationAudio'
  s.version        = '1.0.0'
  s.summary        = 'Navigation speech and audio focus for OpenMapX'
  s.description    = 'Speaks short, already-localised navigation guidance with voice-prompt audio session behaviour.'
  s.author         = 'OpenMapX'
  s.homepage       = 'https://openmapx.com'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: 'https://github.com/OpenMapX/openmapx.git' }
  s.license        = { type: 'Apache-2.0', file: '../../../LICENSE' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  # Non-recursive on purpose: `Tests/` holds the host-side XCTest sources that
  # `swift test` compiles, and they must never enter the app binary.
  s.source_files = '*.{h,m,mm,swift,hpp,cpp}'
  s.exclude_files = 'Tests/**/*'
end
