Pod::Spec.new do |s|
  s.name = 'OpenMapXNavigationSurfaces'
  s.version = '1.0.0'
  s.summary = 'Local OpenMapX navigation surfaces'
  s.description = 'ActivityKit host adapter; the WidgetKit entry point belongs only to the generated extension.'
  s.author = 'OpenMapX'
  s.homepage = 'https://github.com/OpenMapX/openmapx'
  s.license = 'AGPL-3.0-or-later'
  s.platforms = { :ios => '16.4' }
  s.source = { :git => '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.source_files = '*.swift'
  s.frameworks = 'ActivityKit', 'UIKit'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.resource_bundles = { 'OpenMapXNavigationSurfaces_privacy' => ['PrivacyInfo.xcprivacy'] }
  s.swift_version = '5.9'
end
